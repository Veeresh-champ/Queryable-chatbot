"""Claude-style report artifacts: one artifact per topic, a new version per follow-up.

Every database answer also produces a ``report`` artifact: the question, key
numbers, findings, chart, map, the full (PII-masked) result table and the
exact query, in one self-contained payload the side panel renders.

The *topic* is the dataset the question is about. Inside one conversation,
every question about the same dataset updates that topic's artifact as a new
version (v1, v2, ...); a question about another dataset starts a new artifact.
The artifact id is stable (``<thread>:<collection>``), so OpenUI keeps the
versions together and opens the latest one by default.

Stored artifacts (``backend.artifacts``) keep one library entry per topic with
its recent versions, so a report reopened from the library can still step
through its history.
"""

import re
from datetime import datetime, timezone

from backend.db import db
from backend.guardrails import redact_pii
from backend.profiling import pretty

MAX_ROWS = 200
MAX_VERSIONS = 12


def collections_in(query):
    """The collection a query reads plus any it combines with $unionWith."""

    if not isinstance(query, dict) or not isinstance(query.get("collection"), str):
        return []
    names = [query["collection"]]
    for stage in query.get("pipeline") or []:
        if isinstance(stage, dict) and "$unionWith" in stage:
            union = stage["$unionWith"]
            target = union if isinstance(union, str) else (union or {}).get("coll")
            if isinstance(target, str) and target not in names:
                names.append(target)
    return names


def topic_of(query):
    """The topic key: one dataset, or several combined ("combined:a+b")."""

    names = collections_in(query)
    if not names:
        return None
    return names[0] if len(names) == 1 else "combined:" + "+".join(sorted(names))


def topic_id(thread_id, collection):
    return f"{thread_id or 'chat'}:{collection}"


def library_id(username, artifact_id):
    return f"report:{username}:{artifact_id}"


def dataset_label(collection):
    upload = db["app_datasets"].find_one({"name": collection}, {"label": 1}) or {}
    meta = db["app_catalog_meta"].find_one({"_id": collection}, {"label": 1}) or {}
    return upload.get("label") or meta.get("label") or collection.replace("_", " ").title()


def previous_versions(username, artifact_id):
    doc = db["app_artifacts"].find_one({"_id": library_id(username, artifact_id)}, {"content.versions": 1})
    return ((doc or {}).get("content") or {}).get("versions") or []


def _flatten(row, prefix=""):
    out = {}
    for key, value in (row or {}).items():
        name = f"{prefix}{key}"
        if key == "_id" and isinstance(value, dict):
            out.update(_flatten(value))
        elif isinstance(value, dict):
            out.update(_flatten(value, f"{name}."))
        elif isinstance(value, list):
            out[name] = ", ".join(str(v) for v in value[:20])
        else:
            out[name] = value
    return out


def _table(rows):
    flat = [_flatten(r) for r in redact_pii(rows[:MAX_ROWS]) if isinstance(r, dict)]
    columns = []
    for row in flat:
        for key in row:
            if key not in columns:
                columns.append(key)
    return {"columns": [{"key": c, "label": pretty(c) if c != "_id" else "Group"} for c in columns[:16]],
            "rows": [{c: row.get(c) for c in columns[:16]} for row in flat]}


def _headline_numbers(table):
    """Up to 4 KPI tiles: a single-row result's numbers, or the row count."""

    rows = table["rows"]
    tiles = []
    if len(rows) == 1:
        for column in table["columns"]:
            value = rows[0].get(column["key"])
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                tiles.append({"label": column["label"], "value": value})
    if not tiles:
        tiles.append({"label": "Rows in the answer", "value": len(rows)})
    return tiles[:4]


def _title(question):
    text = re.sub(r"\s+", " ", question or "").strip().rstrip("?.!")
    return (text[:1].upper() + text[1:])[:90] or "Analysis"


def build(username, thread_id, question, query, rows, tool_results, project=None):
    """The ``answer_artifact`` payload for one database answer, or None."""

    collection = topic_of(query)
    if not collection or not isinstance(rows, list):
        return None
    artifact_id = topic_id(thread_id, collection)
    history = previous_versions(username, artifact_id) if thread_id else []
    names = collections_in(query)
    if len(names) > 1:
        owner = db["app_projects"].find_one({"_id": project}, {"name": 1}) if project else None
        label = f"{owner['name']} (all datasets)" if owner else "Combined datasets"
    else:
        label = dataset_label(collection)
    results = {name: result for name, _, result in tool_results}
    visual = results.get("visual_analysis")
    insights = results.get("data_insights")
    geo = results.get("geo_map")
    findings = (visual or {}).get("insights") or (insights or {}).get("insights") or []
    table = _table(rows)
    version = len(history) + 1
    return {
        "artifact_id": artifact_id,
        "version": version,
        "topic": label,
        "collection": collection,
        "project": project,
        "heading": f"{label} analysis",
        "title": _title(question),
        "question": question,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "kpis": _headline_numbers(table),
        "findings": findings[:6],
        "visual": visual,
        "insights": insights if not visual else None,
        "geo": geo if geo and geo.get("places") else None,
        "table": table,
        "total_rows": len(rows),
        "truncated": len(rows) > MAX_ROWS,
        "query": query,
        # Earlier versions of this topic (titles only; full content is in the library entry).
        "history": [{"version": v.get("version"), "title": v.get("title"), "created_at": v.get("created_at")}
                    for v in history][-MAX_VERSIONS:],
    }
