"""Data catalog admin API: browse collections and add datasets from Excel/CSV.

Admins (browser session, ``role == "admin"``) drop an ``.xlsx`` or ``.csv``
file, see a preview of the detected columns and types, and import it as a
new MongoDB collection. The chatbot picks it up on the next question: schema
discovery is cleared after every import, and uploaded collections are always
queryable, even when ``QUERYABLE_COLLECTIONS`` restricts the sample data.

    GET    /api/catalog                     -> collections, fields, samples, dataset metadata
    POST   /api/catalog/preview             -> parse a file, return columns/types/first rows (no write)
    POST   /api/catalog/upload              -> import a file as a collection
    PATCH  /api/catalog/{name}              -> rename label / edit description
    DELETE /api/catalog/{name}              -> drop an uploaded dataset

Uploads can target one project (``project`` form field) and carry tags.
Every preview includes a data-quality report (empty and sparse columns,
duplicate rows and accounts, identical columns, values with mixed units,
broken characters, unrecognised countries). Text columns that hold numbers
written for people ("1,000+", "$1.26B", "100K-300K", "4.3/5") also get a
numeric twin ``<column>_num`` holding the **lower bound** that is actually
written; values without a number, or money without a unit, stay empty
rather than being guessed. Yes/No columns with notes ("Yes (Dine-in)") get
a boolean twin ``<column>_flag``. The original text is always kept.

Every import, edit and delete is written to the admin audit log. Only
collections created by an upload can be replaced or deleted from here; the
sample collections are protected.
"""

import csv
import io
import json
import re
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from backend.admin import _audit, require_admin
from backend.config import INTERNAL_COLLECTIONS
from backend import projects as project_store
from backend.db import business_collection_names, db, disabled_collections, invalidate_project_cache
from backend.geo import lookup as geo_lookup
from backend.guardrails import redact_pii
from backend.schema_discovery import clear_schema_cache, get_schema

router = APIRouter(prefix="/api/catalog", tags=["catalog"])

datasets = db["app_datasets"]

MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_ROWS = 100_000
MAX_COLUMNS = 300
PREVIEW_ROWS = 8
BATCH = 1000
NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{1,47}$")
ALLOWED_SUFFIXES = (".csv", ".tsv", ".txt", ".xlsx", ".xlsm", ".json", ".jsonl", ".ndjson")
TEMPORARY_HOURS = 24  # "Use without saving" uploads are dropped after this

TRUE_WORDS = {"true", "yes", "y"}
FALSE_WORDS = {"false", "no", "n"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$")
INT_RE = re.compile(r"^[+-]?\d+$")
FLOAT_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def ensure_indexes():
    datasets.create_index("name", unique=True)
    purge_expired()


def purge_expired(now=None):
    """Drop "use without saving" uploads whose time is up. Returns their names."""

    now = now or datetime.now(timezone.utc)
    gone = []
    for doc in datasets.find({"temporary": True, "expires_at": {"$lte": now}}, {"name": 1}):
        db[doc["name"]].drop()
        datasets.delete_one({"name": doc["name"]})
        project_store.projects.update_many({}, {"$pull": {"datasets": doc["name"]}})
        project_store.catalog_meta.delete_one({"_id": doc["name"]})
        gone.append(doc["name"])
    if gone:
        invalidate_project_cache()
        clear_schema_cache()
    return gone


def _bad(code, message, status=400):
    return HTTPException(status_code=status, detail={"code": code, "message": message})


# --------------------------------------------------
# Parsing
# --------------------------------------------------

def snake(text, fallback):
    """'Annual Revenue ($)' -> 'annual_revenue'. Field names the query agent can use."""

    value = re.sub(r"[^0-9a-zA-Z]+", "_", str(text or "").strip()).strip("_").lower()
    if not value:
        value = fallback
    if value[0].isdigit():
        value = f"c_{value}"
    return value[:64]


def dataset_name(filename):
    stem = re.sub(r"\.[^.]+$", "", filename or "")
    name = snake(stem, "dataset")
    if not name[0].isalpha():
        name = f"d_{name}"
    if len(name) < 2:
        name = f"{name}_data"
    return name[:48]


def _headers(raw):
    seen = {}
    out = []
    for index, header in enumerate(raw, start=1):
        name = snake(header, f"column_{index}")
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 1
        out.append(name)
    return out


def _cell_text(value):
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ") if value.time() != time(0) else value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _decode(content):
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise _bad("bad_file", "The CSV file is not valid text.")


def _read_csv(content):
    text = _decode(content)
    try:
        dialect = csv.Sniffer().sniff(text[:20000], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return [row for row in csv.reader(io.StringIO(text), dialect)]


def _flatten_record(record, prefix=""):
    """{"a": {"b": 1}} -> {"a_b": 1}; lists are kept as readable text."""

    out = {}
    for key, value in record.items():
        name = f"{prefix}{key}"
        if isinstance(value, dict):
            out.update(_flatten_record(value, f"{name}_"))
        elif isinstance(value, list):
            out[name] = ", ".join(str(v) for v in value if v is not None)
        else:
            out[name] = value
    return out


def _read_json(content):
    """JSON array of objects, a {"data": [...]} style wrapper, or JSON Lines -> header + rows."""

    text = _decode(content).strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            records = parsed
        elif isinstance(parsed, dict):
            lists = [v for v in parsed.values() if isinstance(v, list) and v and all(isinstance(i, dict) for i in v)]
            records = lists[0] if lists else [parsed]
        else:
            records = []
    except json.JSONDecodeError:
        records = []
        for number, line in enumerate(text.splitlines(), start=1):
            if line.strip():
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError as error:
                    raise _bad("bad_file", f"Line {number} is not valid JSON.") from error
    records = [_flatten_record(r) for r in records if isinstance(r, dict)]
    if not records:
        raise _bad("bad_file", "The JSON file needs a list of objects (one object per row).")
    header = []
    for record in records[: MAX_ROWS + 1]:
        for key in record:
            if key not in header:
                header.append(key)
    rows = [header]
    for record in records[: MAX_ROWS + 1]:
        rows.append([_cell_text(record.get(key)) for key in header])
    return rows


def _read_xlsx(content, sheet=None):
    try:
        from openpyxl import load_workbook
    except ImportError as error:  # pragma: no cover - dependency missing
        raise _bad("unsupported", "Excel support is not installed on the server (openpyxl).", 500) from error
    try:
        book = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except Exception as error:  # noqa: BLE001 - any corrupt workbook
        raise _bad("bad_file", "The Excel file could not be read. Save it as .xlsx and try again.") from error
    try:
        names = book.sheetnames
        if sheet and sheet not in names:
            raise _bad("bad_sheet", f"Sheet '{sheet}' was not found. Sheets: {', '.join(names)}.")
        target = book[sheet] if sheet else None
        if target is None:
            # First sheet with data.
            for name in names:
                if book[name].max_row and book[name].max_row > 1:
                    target = book[name]
                    break
            target = target or book[names[0]]
        rows = []
        for row in target.iter_rows(values_only=True):
            rows.append([_cell_text(value) for value in row])
            if len(rows) > MAX_ROWS + 50:
                break
        return rows, names, target.title
    finally:
        book.close()


def _infer(values):
    """Column type from its non-empty text values: int, float, bool, date or str."""

    present = [v for v in values if v != ""]
    if not present:
        return "str"
    if any(len(v) > 1 and v[0] == "0" and v[1].isdigit() for v in present):
        return "str"  # codes and zip codes keep their leading zeros
    if all(INT_RE.match(v.replace(",", "")) for v in present):
        return "int"
    if all(FLOAT_RE.match(v.replace(",", "")) for v in present):
        return "float"
    if all(v.lower() in TRUE_WORDS | FALSE_WORDS for v in present):
        return "bool"
    if all(DATE_RE.match(v) for v in present):
        return "date"
    return "str"


def _convert(value, kind):
    if value == "":
        return None
    try:
        if kind == "int":
            number = int(value.replace(",", ""))
            return number if abs(number) < 2**63 else float(number)
        if kind == "float":
            return float(value.replace(",", ""))
    except ValueError:
        return value
    if kind == "bool":
        return value.lower() in TRUE_WORDS
    return value  # dates stay ISO text: sortable and safe in every response


# --------------------------------------------------
# Numbers written for people, and data quality
# --------------------------------------------------

_DASHES = "‒–—―�"
_SCALE = {"k": 1e3, "thousand": 1e3, "m": 1e6, "mn": 1e6, "million": 1e6,
          "b": 1e9, "bn": 1e9, "billion": 1e9, "t": 1e12, "tn": 1e12, "trillion": 1e12}
_UNIT = r"(?P<unit>thousand|million|billion|trillion|mn|bn|tn|k|m|b|t)?"
_AMOUNT = re.compile(
    r"^\s*(?:approx\.?|about|~|est\.?)?\s*(?P<cur>\$|usd\s*|us\$)?\s*"
    r"(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*" + _UNIT + r"(?![a-z])\s*(?P<rest>.*)$",
    re.IGNORECASE,
)
_RANGE_SECOND = re.compile(
    r"^(?:-|to)\s*(?:\$|usd\s*)?\s*(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*"
    r"(thousand|million|billion|trillion|mn|bn|tn|k|m|b|t)?(?![a-z])",
    re.IGNORECASE,
)
_SCALE_WORD = re.compile(r"^\+?\s*(thousand|million|billion|trillion)\b", re.IGNORECASE)
_MONEY_FIELD = re.compile(r"(usd|asset|deposit|revenue|income|equity|spend|sales|turnover|profit|capital)", re.I)
_SKIP_DERIVE = re.compile(r"(^id$|_id$|^id_|rssd|fdic|ncua|charter|certificate|phone|zip|postal|code$)", re.I)
_YESNO = re.compile(r"^(yes|no)\b", re.IGNORECASE)


def _normalise_text(value):
    text = str(value)
    for dash in _DASHES:
        text = text.replace(dash, "-")
    return text.strip()


def parse_amount(value, money=False):
    """(lower_bound, has_unit) for text such as '1,000+', '$4.0B-5.0B', '4.3/5'.

    Returns (None, False) when the text does not start with a number. A range
    gives its lower bound and '+' means 'at least', so the number actually
    written is used. In money columns a bare number with neither '$' nor a
    scale ('4627': dollars? millions?) is ambiguous and returns None.
    """

    text = _normalise_text(value)
    match = _AMOUNT.match(text)
    if not match:
        return None, False
    number = float(match.group("num").replace(",", ""))
    unit = (match.group("unit") or "").lower()
    rest = (match.group("rest") or "").strip()
    if rest.startswith("/"):  # '4.3/5' rating: keep the score
        return number, True
    if not unit and "," not in match.group("num") and number < 1000:
        # '$40-60M': the scale is written once, after the range. Not for
        # '500,000-1M', where the first number is already complete.
        second = _RANGE_SECOND.match(rest)
        if second and second.group(1):
            unit = second.group(1).lower()
    if not unit:
        word = _SCALE_WORD.match(rest)  # '1 Million+ clients'
        if word:
            unit = word.group(1).lower()
    if money and not unit and not match.group("cur"):
        return None, False
    return number * _SCALE.get(unit, 1.0), bool(unit or match.group("cur"))


def _derive(columns, types, grid):
    """Numeric (``_num``) and yes/no (``_flag``) twins for human-written text columns.

    Returns (derived, skipped): ``skipped`` lists money columns whose units are
    too mixed to read safely, so the quality report can say so.
    """

    derived, skipped = [], []
    names = set(columns)
    for index, (name, kind) in enumerate(zip(columns, types)):
        if kind != "str" or _SKIP_DERIVE.search(name):
            continue
        values = [row[index] for row in grid if row[index] != ""]
        if len(values) < 3:
            continue
        if all(_YESNO.match(v) for v in values):
            target = f"{name}_flag"
            if target not in names:
                derived.append({
                    "name": target, "source": name, "type": "bool",
                    "values": [(_YESNO.match(row[index]).group(1).lower() == "yes") if row[index] else None
                               for row in grid],
                })
            continue
        money = bool(_MONEY_FIELD.search(name))
        parsed = [parse_amount(v, money)[0] for v in values]
        readable = sum(1 for number in parsed if number is not None)
        if readable < max(3, 0.6 * len(values)):
            if money and readable >= 3:
                bare = [v for v, number in zip(values, parsed) if number is None]
                skipped.append({"source": name, "readable": readable, "total": len(values),
                                "examples": list(dict.fromkeys(bare))[:3]})
            continue
        target = f"{name}_num"
        if target in names:
            continue
        out, unparsed = [], []
        for row in grid:
            if row[index] == "":
                out.append(None)
                continue
            number = parse_amount(row[index], money)[0]
            out.append(number)
            if number is None:
                unparsed.append(row[index])
        derived.append({"name": target, "source": name, "type": "float", "values": out, "unparsed": unparsed})
    return derived, skipped


def quality_report(columns, grid, derived, skipped=()):
    """Data-quality findings for a parsed sheet. Reports only: nothing is changed or dropped."""

    rows = len(grid)
    if not rows:
        return {"rows": 0, "completeness": 0, "score": 0, "issues": []}
    issues = []
    names = [c["name"] for c in columns]
    fill = {c["name"]: c["filled"] for c in columns}

    empty = [n for n in names if fill[n] == 0]
    if empty:
        issues.append({"level": "warning", "code": "empty_columns", "columns": empty,
                       "message": f"{len(empty)} column(s) have no values and are not stored: {', '.join(empty)}."})
    sparse = [n for n in names if 0 < fill[n] < rows * 0.5]
    if sparse:
        issues.append({"level": "info", "code": "sparse_columns", "columns": sparse,
                       "message": "Under half filled: " + ", ".join(f"{n} ({fill[n] / rows:.0%})" for n in sparse)
                       + ". Accounts without a value are left out of anything that uses that field."})

    id_cols = {n for n in names if n in {"id", "s_no", "sr_no", "no"}}
    keyed = [tuple(v for n, v in zip(names, row) if n not in id_cols) for row in grid]
    dupes = rows - len(set(keyed))
    if dupes:
        issues.append({"level": "warning", "code": "duplicate_rows",
                       "message": f"{dupes} row(s) repeat another row exactly (ignoring the ID column)."})

    name_col = next((n for n in names if re.search(r"(company|account|organi[sz]ation|business)_?name|^name$", n)), None)
    country_col = next((n for n in names if n == "country" or n.endswith("_country")), None)
    if name_col:
        i = names.index(name_col)
        j = names.index(country_col) if country_col else None
        keys = [(row[i].strip().lower(), row[j].strip().lower() if j is not None else "") for row in grid if row[i]]
        repeated = len(keys) - len(set(keys))
        if repeated:
            issues.append({"level": "info", "code": "repeated_accounts", "columns": [name_col],
                           "message": f"{repeated} row(s) repeat a company already listed in the same country "
                                      f"({len(set(keys))} distinct accounts). Insights count each account once."})
    if country_col:
        j = names.index(country_col)
        unknown = sorted({row[j] for row in grid if row[j] and not geo_lookup(row[j])})
        if unknown:
            issues.append({"level": "info", "code": "unknown_countries", "columns": [country_col],
                           "message": "Not recognised as countries (left off maps): " + ", ".join(unknown[:8]) + "."})

    for a in range(len(names)):
        for b in range(a + 1, len(names)):
            if fill[names[a]] and fill[names[a]] == fill[names[b]] and all(row[a] == row[b] for row in grid):
                issues.append({"level": "warning", "code": "identical_columns", "columns": [names[a], names[b]],
                               "message": f"'{names[b]}' is an exact copy of '{names[a]}'. Check the source sheet; "
                                          f"'{names[b]}' should not be relied on."})

    broken = sum(1 for row in grid for v in row if "�" in v)
    if broken:
        issues.append({"level": "info", "code": "broken_characters",
                       "message": f"{broken} value(s) contain a broken character (�), most likely a dash in a "
                                  "range such as '100K�300K'. It is read as a dash for numbers; the text is kept."})

    for d in derived:
        unparsed = d.get("unparsed") or []
        if unparsed:
            sample = ", ".join(f"'{v}'" for v in list(dict.fromkeys(unparsed))[:4])
            issues.append({"level": "warning", "code": "mixed_units", "columns": [d["source"]],
                           "message": f"{len(unparsed)} value(s) in '{d['source']}' have no usable number or no unit "
                                      f"(e.g. {sample}). '{d['name']}' stays empty for them instead of guessing."})
    for item in skipped:
        sample = ", ".join(f"'{v}'" for v in item["examples"])
        issues.append({"level": "warning", "code": "ambiguous_units", "columns": [item["source"]],
                       "message": f"'{item['source']}' mixes values with a unit and bare numbers (e.g. {sample}): "
                                  f"only {item['readable']} of {item['total']} can be read safely, so no numeric "
                                  "field was created. Confirm the unit (dollars or millions) in the source."})
    if derived:
        issues.append({"level": "info", "code": "derived_fields", "columns": [d["name"] for d in derived],
                       "message": "Added for ranking and filtering: "
                                  + ", ".join(f"{d['name']} ← {d['source']}" for d in derived)
                                  + ". Numbers are the lower bound written in the text ('1,000+' → 1000)."})

    used = [n for n in names if fill[n]]
    completeness = sum(fill[n] for n in used) / (rows * len(used)) if used else 0
    warnings = sum(1 for issue in issues if issue["level"] == "warning")
    return {"rows": rows, "completeness": round(completeness, 3),
            "score": max(0, round(100 * completeness) - 5 * warnings), "issues": issues}


def parse_upload(filename, content, sheet=None):
    """Turn file bytes into (columns, types, documents, sheet info)."""

    suffix = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in (filename or "") else ""
    if suffix not in ALLOWED_SUFFIXES:
        if suffix == ".xls":
            raise _bad("unsupported", "Old .xls files are not supported. Save the file as .xlsx or .csv.")
        raise _bad("unsupported", "Upload a CSV, TSV, TXT, Excel (.xlsx) or JSON file.")
    if not content:
        raise _bad("bad_file", "The file is empty.")
    if len(content) > MAX_FILE_BYTES:
        raise _bad("too_large", f"Files up to {MAX_FILE_BYTES // (1024 * 1024)} MB are supported.", 413)

    sheets, sheet_used = [], None
    if suffix in {".csv", ".tsv", ".txt"}:
        rows = _read_csv(content)
    elif suffix in {".json", ".jsonl", ".ndjson"}:
        rows = _read_json(content)
    else:
        rows, sheets, sheet_used = _read_xlsx(content, sheet)

    rows = [[_cell_text(c) if not isinstance(c, str) else c.strip() for c in row] for row in rows]
    rows = [row for row in rows if any(cell != "" for cell in row)]
    if len(rows) < 2:
        raise _bad("bad_file", "The file needs a header row and at least one data row.")

    width = max(len(row) for row in rows)
    # Drop trailing columns that are empty everywhere (common in Excel exports).
    while width and all(len(row) < width or row[width - 1] == "" for row in rows):
        width -= 1
    if width > MAX_COLUMNS:
        raise _bad("too_large", f"Up to {MAX_COLUMNS} columns are supported.")

    header, body = rows[0], rows[1:]
    if len(body) > MAX_ROWS:
        raise _bad("too_large", f"Up to {MAX_ROWS:,} rows are supported; this file has more.", 413)

    columns = _headers([header[i] if i < len(header) else "" for i in range(width)])
    grid = [[row[i] if i < len(row) else "" for i in range(width)] for row in body]
    types = [_infer([row[i] for row in grid]) for i in range(width)]

    derived, skipped = _derive(columns, types, grid)

    documents = []
    for r, row in enumerate(grid):
        doc = {}
        for column, kind, value in zip(columns, types, row):
            converted = _convert(value, kind)
            if converted is not None:
                doc[column] = converted
        if doc:
            for extra in derived:
                value = extra["values"][r]
                if value is not None:
                    doc[extra["name"]] = value
            documents.append(doc)

    original = [str(header[i]) if i < len(header) else "" for i in range(width)]
    column_info = [
        {"name": name, "original": orig, "type": kind,
         "filled": sum(1 for row in grid if row[i] != "")}
        for i, (name, orig, kind) in enumerate(zip(columns, original, types))
    ]
    quality = quality_report(column_info, grid, derived, skipped)
    for extra in derived:
        column_info.append({"name": extra["name"], "original": f"derived from {extra['source']}",
                            "type": extra["type"], "derived_from": extra["source"],
                            "filled": sum(1 for v in extra["values"] if v is not None)})
    return {
        "columns": column_info,
        "documents": documents,
        "sheets": sheets,
        "sheet": sheet_used,
        "quality": quality,
    }


# --------------------------------------------------
# Catalog
# --------------------------------------------------

def _meta_by_name():
    return {doc["name"]: doc for doc in datasets.find({}, {"_id": 0})}


def _iso(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return value


def _public_meta(doc):
    if not doc:
        return None
    return {
        "label": doc.get("label"),
        "description": doc.get("description", ""),
        "filename": doc.get("filename"),
        "sheet": doc.get("sheet"),
        "uploaded_by": doc.get("uploaded_by"),
        "uploaded_at": _iso(doc.get("uploaded_at")),
        "rows": doc.get("rows"),
        "quality": doc.get("quality"),
        "temporary": bool(doc.get("temporary")),
        "expires_at": _iso(doc.get("expires_at")) if doc.get("temporary") else None,
    }


def catalog():
    """Every collection (including those in projects that are switched off), for admins."""

    schema = get_schema(all_collections=True)
    meta = _meta_by_name()
    extra = project_store.tags_by_collection()
    off = disabled_collections()
    every = business_collection_names(include_disabled=True, scoped=False)
    collections = []
    for name in sorted(set(schema) | {n for n in meta if n in every}):
        fields = schema.get(name, {})
        info = meta.get(name)
        tagging = extra.get(name) or {}
        collections.append({
            "name": name,
            "documents": db[name].estimated_document_count(),
            "source": "upload" if info else "sample",
            "project": tagging.get("project"),
            "tags": tagging.get("tags") or [],
            "category": tagging.get("category"),
            "active": name not in off,
            "dataset": _public_meta(info),
            "fields": [{"name": field, "type": details.get("type"),
                        "samples": redact_pii([{field: value} for value in details.get("sample_values", [])])}
                       for field, details in fields.items()],
        })
    return {"collections": collections}


@router.get("")
def get_catalog(admin=Depends(require_admin)):
    """Collections and fields the chatbot can read (PII-masked samples). Admins only."""

    purge_expired()
    return catalog()


def _check_name(name, mode):
    if not NAME_PATTERN.match(name or ""):
        raise _bad("bad_name", "Use 2-48 lowercase letters, digits or _, starting with a letter.")
    if name in INTERNAL_COLLECTIONS or name.startswith(("app_", "system")):
        raise _bad("bad_name", "That name is reserved by the application.")
    exists = name in db.list_collection_names()
    uploaded = datasets.find_one({"name": name}) is not None
    if exists and not uploaded:
        raise _bad("name_taken", f"'{name}' is a built-in collection and cannot be replaced. Pick another name.", 409)
    if uploaded and mode == "create":
        raise _bad("name_taken", f"A dataset called '{name}' already exists. Choose Replace or Append.", 409)
    return exists


async def _read(file: UploadFile):
    content = await file.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise _bad("too_large", f"Files up to {MAX_FILE_BYTES // (1024 * 1024)} MB are supported.", 413)
    return content


@router.post("/preview")
async def preview(
    file: UploadFile = File(...),
    sheet: str | None = Form(None),
    admin=Depends(require_admin),
):
    """Parse the file and show what would be imported, without writing anything."""

    parsed = parse_upload(file.filename, await _read(file), sheet or None)
    suggested = suggested_name(file.filename, parsed["sheet"], parsed["sheets"])
    existing = datasets.find_one({"name": suggested}, {"_id": 0, "name": 1})
    return {
        "filename": file.filename,
        "suggested_name": suggested,
        "suggested_tags": suggested_tags(parsed["sheet"], parsed["sheets"]),
        "exists": bool(existing) or suggested in db.list_collection_names(),
        "rows": len(parsed["documents"]),
        "columns": parsed["columns"],
        "sheets": parsed["sheets"],
        "sheet": parsed["sheet"],
        "quality": parsed["quality"],
        "preview": parsed["documents"][:PREVIEW_ROWS],
    }


def _sheet_words(sheet):
    """'2_Insurance' -> 'insurance', '5_Banking, Financial' -> 'banking_financial'."""

    return snake(re.sub(r"^\s*\d+\s*[_.)-]\s*", "", sheet or ""), "sheet")


def suggested_name(filename, sheet, sheets):
    """One collection per industry sheet: 'vaf_samples' + '_insurance'."""

    base = dataset_name(filename)
    if not sheet or len(sheets or []) < 2:
        return base
    stem = "_".join(base.split("_")[:2])
    return f"{stem}_{_sheet_words(sheet)}"[:48].rstrip("_")


def suggested_tags(sheet, sheets):
    if not sheet or len(sheets or []) < 2:
        return []
    return [_sheet_words(sheet).replace("_", "-")[:32]]


@router.post("/upload", status_code=201)
async def upload(
    file: UploadFile = File(...),
    name: str | None = Form(None),
    label: str | None = Form(None),
    description: str = Form(""),
    sheet: str | None = Form(None),
    mode: str = Form("create"),
    project: str | None = Form(None),
    tags: str = Form(""),
    temporary: bool = Form(False),
    admin=Depends(require_admin),
):
    """Import one file (or sheet) as a queryable collection, optionally into a project.

    ``temporary=true`` is "use without saving": the data can be queried right
    away and is deleted automatically after TEMPORARY_HOURS unless kept.
    """

    purge_expired()
    return import_file(file.filename, await _read(file), actor=admin, name=name, label=label,
                       description=description, sheet=sheet, mode=mode, project=project, tags=tags,
                       temporary=temporary)


def import_file(filename, content, actor, name=None, label=None, description="", sheet=None,
                mode="create", project=None, tags="", temporary=False):
    """Parse, validate and store one sheet. Shared by the upload API and scripts.

    Safe by construction: the target project and name are checked before
    anything is written, rows go into a staging collection first, and the
    live collection is swapped in only once every row is stored, so a failed
    import never leaves a half-written or empty dataset behind.
    """

    if mode not in {"create", "replace", "append"}:
        raise _bad("bad_request", "mode must be create, replace or append.")
    target_project = None
    if project:
        target_project = project_store.projects.find_one({"_id": project}, {"_id": 1, "name": 1})
        if not target_project:
            raise _bad("project_not_found", "The selected project does not exist.", 404)
    parsed = parse_upload(filename, content, sheet or None)
    name = (name or suggested_name(filename, parsed["sheet"], parsed["sheets"])).strip().lower()
    _check_name(name, mode)
    documents = parsed["documents"]
    if not documents:
        raise _bad("bad_file", "No rows with values were found.")

    collection = db[name]
    if mode == "append":
        for start in range(0, len(documents), BATCH):
            collection.insert_many(documents[start:start + BATCH], ordered=False)
    else:
        staging = db[f"{name}__staging"]
        staging.drop()
        try:
            for start in range(0, len(documents), BATCH):
                staging.insert_many(documents[start:start + BATCH], ordered=False)
            staging.rename(name, dropTarget=True)
        except Exception:
            staging.drop()
            raise

    now = datetime.now(timezone.utc)
    total = collection.count_documents({})
    clean_label = (label or "").strip()[:80] or name.replace("_", " ").title()
    datasets.update_one(
        {"name": name},
        {
            "$set": {
                "label": clean_label,
                "description": (description or "").strip()[:500],
                "filename": filename,
                "sheet": parsed["sheet"],
                "columns": [{"name": c["name"], "type": c["type"]} for c in parsed["columns"]],
                "rows": total,
                "quality": parsed["quality"],
                "uploaded_by": actor["username"],
                "uploaded_at": now,
            },
            "$setOnInsert": {"name": name, "created_at": now},
        },
        upsert=True,
    )
    if temporary:
        datasets.update_one({"name": name}, {"$set": {"temporary": True,
                                                      "expires_at": now + timedelta(hours=TEMPORARY_HOURS)}})
    else:
        datasets.update_one({"name": name}, {"$unset": {"temporary": "", "expires_at": ""}})
    clean_tags = project_store._clean_tags(tags.split(",")) if tags else []
    if clean_tags:
        project_store.catalog_meta.update_one({"_id": name}, {"$set": {"tags": clean_tags}}, upsert=True)
    clear_schema_cache()
    if target_project:
        project_store.assign(target_project["_id"], [name])
    _audit(actor, "dataset.upload", name,
           {"filename": filename, "sheet": parsed["sheet"], "rows": len(documents), "mode": mode,
            "columns": len(parsed["columns"]), "project": project, "tags": clean_tags, "temporary": temporary})
    return {
        "name": name,
        "label": clean_label,
        "rows_imported": len(documents),
        "rows_total": total,
        "columns": parsed["columns"],
        "quality": parsed["quality"],
        "project": target_project["_id"] if target_project else None,
        "tags": clean_tags,
        "mode": mode,
        "temporary": temporary,
        "expires_hours": TEMPORARY_HOURS if temporary else None,
    }


class DatasetPatch(BaseModel):
    label: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=500)


def _uploaded(name):
    doc = datasets.find_one({"name": name})
    if not doc:
        raise _bad("not_found", "Only uploaded datasets can be changed here.", 404)
    return doc


@router.patch("/{name}")
def update_dataset(name: str, payload: DatasetPatch, admin=Depends(require_admin)):
    _uploaded(name)
    changes = {key: value.strip() for key, value in payload.model_dump(exclude_none=True).items()}
    if changes:
        datasets.update_one({"name": name}, {"$set": changes})
        _audit(admin, "dataset.update", name, changes)
    return {"name": name, "dataset": _public_meta(datasets.find_one({"name": name}))}


@router.post("/{name}/keep")
def keep_dataset(name: str, admin=Depends(require_admin)):
    """Turn a "use without saving" upload into a saved dataset."""

    _uploaded(name)
    datasets.update_one({"name": name}, {"$unset": {"temporary": "", "expires_at": ""}})
    _audit(admin, "dataset.keep", name, {})
    return {"name": name, "dataset": _public_meta(datasets.find_one({"name": name}))}


@router.delete("/{name}")
def delete_dataset(name: str, admin=Depends(require_admin)):
    doc = _uploaded(name)
    db[name].drop()
    datasets.delete_one({"name": name})
    project_store.projects.update_many({}, {"$pull": {"datasets": name}})
    project_store.catalog_meta.delete_one({"_id": name})
    invalidate_project_cache()
    clear_schema_cache()
    _audit(admin, "dataset.delete", name, {"rows": doc.get("rows"), "filename": doc.get("filename")})
    return {"deleted": name}


def uploaded_names():
    try:
        return set(datasets.distinct("name"))
    except Exception:  # noqa: BLE001 - MongoDB down: callers handle it
        return set()
