"""Auto-built dashboards for a project or a single dataset (no LLM, every number from MongoDB).

Charts are chosen from each dataset's field roles (``backend.profiling``), so
the same code serves the sample data, the VAF industry sheets and any future
upload. Each chart is a small spec ``{id, kind, title, subtitle, data}`` that
``openui_test/src/components/viz`` renders. Forms, by the job they do:

    Project overview                      Dataset deep-dive
    ----------------                      -----------------
    kpis      headline numbers            bar        top segments / industries
    map       accounts by country         stacked    capability adoption (yes / no / unknown)
    heatmap   country x dataset           dumbbell   adoption: leading country vs the rest
    treemap   dataset -> country          histogram  distribution of the size measure (log bins)
    sankey    country -> dataset -> use   box        size measure by country
    bar       opportunity accounts        scatter    size vs financial measure (log-log)
    coverage  completeness per dataset    pareto     concentration of the financial/size measure
                                          lollipop   top accounts by measure
                                          trend      change over time (when there is a date)
                                          coverage   fill rate of every field (VAF coverage)

Accounts are counted once (repeated rows merged). Missing values are left
out of a chart and the chart says how many were missing; nothing is imputed.
"""

import math
import re
import statistics
from collections import Counter, defaultdict

from backend import profiling
from backend.db import business_collection_names, db
from backend.geo import COUNTRIES, build_geo_payload, lookup

TOP = 10


def _label_of(name):
    upload = db["app_datasets"].find_one({"name": name}, {"label": 1}) or {}
    meta = db["app_catalog_meta"].find_one({"_id": name}, {"label": 1}) or {}
    return upload.get("label") or meta.get("label") or name.replace("_", " ").title()


def _country(value):
    hit = lookup(value) if isinstance(value, str) else None
    if hit and hit[0] == "country":
        return COUNTRIES[hit[1]]["name"]
    return None


def _num(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _fmt_for(field):
    return "currency" if field and re.search(r"usd|revenue|spend|price|assets|deposits|equity|income|sales", field, re.I) \
        else "number"


def _quantiles(values):
    ordered = sorted(values)
    q = statistics.quantiles(ordered, n=4, method="inclusive") if len(ordered) >= 2 else [ordered[0]] * 3
    return ordered[0], q[0], q[1], q[2], ordered[-1]


class Dataset:
    def __init__(self, name):
        self.name = name
        self.label = _label_of(name)
        self.docs = list(db[name].find({}, {"_id": 0}).limit(profiling.SCAN_LIMIT))
        self.roles = profiling.field_roles(name, self.docs)
        self.company = bool(self.roles["name"])
        self.units = profiling.accounts(name, self.roles, self.docs) if self.company else self.docs
        self.country_field = self.roles["country"][0] if self.roles["country"] else None
        self.size_field = self.roles["size"][0] if self.roles["size"] else None
        self.finance_field = self.roles["finance"][0] if self.roles["finance"] else None

    def country_of(self, unit):
        return _country(unit.get(self.country_field)) if self.country_field else None

    def categorical(self):
        """String fields worth a ranked bar: 2-40 distinct short values."""

        out = []
        candidates = self.roles["industry"] + self.roles["deployment"] + [
            f for f in (self.docs[0].keys() if self.docs else []) if f not in self.roles["industry"]]
        seen = set()
        twins = {k[:-4] for doc in self.docs[:50] for k in doc if k.endswith("_num")}
        for field in candidates:
            if field in seen or field in twins or field in self.roles["name"] or field == self.country_field                     or field.endswith(("_num", "_flag")):
                continue
            seen.add(field)
            values = [u.get(field) for u in self.units if isinstance(u.get(field), str) and u.get(field)]
            if len(values) < 3:
                continue
            distinct = len(set(values))
            if 2 <= distinct <= 40 and statistics.fmean(len(v) for v in values) <= 40:
                out.append(field)
        return out


# --------------------------------------------------
# Project-level charts
# --------------------------------------------------

def _kpis(sets):
    records = sum(len(d.docs) for d in sets)
    accounts = sum(len(d.units) for d in sets if d.company)
    countries = {d.country_of(u) for d in sets for u in d.units} - {None}
    fields, filled = 0, 0
    vaf = 0
    for d in sets:
        keys = {k for doc in d.docs for k in doc}
        fields += len(keys)
        filled += sum(1 for doc in d.docs for k in keys if doc.get(k) not in (None, "")) / max(1, len(d.docs))
        vaf += len([k for k in keys if k.endswith(("_num", "_flag"))]) + len(d.roles["capability"])
    completeness = filled / fields if fields else 0
    tiles = [
        {"id": "datasets", "label": "Datasets", "value": len(sets), "format": "number", "hint": "in this scope"},
        {"id": "records", "label": "Records", "value": records, "format": "number", "hint": "rows across datasets"},
    ]
    if accounts:
        tiles.append({"id": "accounts", "label": "Distinct accounts", "value": accounts, "format": "number",
                      "hint": f"{records - accounts:,} repeated rows merged" if records > accounts else "no repeats"})
    if countries:
        tiles.append({"id": "countries", "label": "Countries", "value": len(countries), "format": "number",
                      "hint": "with at least one account"})
    tiles.append({"id": "completeness", "label": "Completeness", "value": round(completeness, 3), "format": "percent",
                  "hint": "share of filled cells"})
    if vaf:
        tiles.append({"id": "vaf", "label": "Value-added fields", "value": vaf, "format": "number",
                      "hint": "numeric, yes/no and capability fields"})
    return tiles


def _map(sets):
    # Only datasets that have a country column can be "missing" a country.
    counts = Counter(d.country_of(u) for d in sets if d.country_field for u in d.units)
    missing = counts.pop(None, 0)
    if not counts:
        return None
    rows = [{"_id": country, "accounts": n} for country, n in counts.most_common()]
    payload = build_geo_payload("", rows)
    if not payload:
        return None
    unit = "accounts" if any(d.company for d in sets) else "records"
    return {"id": "map", "kind": "map", "title": f"Where the {unit} are",
            "subtitle": f"{sum(counts.values()):,} {unit} in {len(counts)} countries"
                        + (f" · {missing:,} without a recognised country" if missing else ""),
            "data": {**payload, "metric": unit.title()}, "wide": True}


def _heatmap(sets):
    with_country = [d for d in sets if d.country_field]
    if len(with_country) < 2:
        return None
    totals = Counter(d.country_of(u) for d in with_country for u in d.units)
    totals.pop(None, None)
    cols = [c for c, _ in totals.most_common(TOP)]
    if len(cols) < 2:
        return None
    rows = [d.label for d in with_country]
    cells = []
    for d in with_country:
        counter = Counter(d.country_of(u) for u in d.units)
        cells.append([counter.get(c, 0) for c in cols])
    return {"id": "heatmap", "kind": "heatmap", "title": "Coverage: dataset × country",
            "subtitle": f"Accounts per cell · top {len(cols)} countries", "wide": True,
            "data": {"rows": rows, "cols": cols, "cells": cells, "format": "number"}}


def _treemap(sets):
    children = []
    for d in sets:
        by = Counter((d.country_of(u) or "Unknown") if d.country_field else "All" for u in d.units)
        top = by.most_common(6)
        rest = sum(by.values()) - sum(n for _, n in top)
        leaves = [{"name": k, "value": v} for k, v in top] + ([{"name": "Other", "value": rest}] if rest else [])
        children.append({"name": d.label, "children": leaves})
    if len(children) < 2:
        return None
    return {"id": "treemap", "kind": "treemap", "title": "Composition: datasets and their countries",
            "subtitle": "Area = accounts. Each dataset's six largest countries, the rest as Other.",
            "data": {"name": "All", "children": children}, "wide": True}


def _dataset_bar(sets):
    if len(sets) < 2:
        return None
    return {"id": "datasets", "kind": "bar", "title": "Accounts per dataset",
            "subtitle": "Distinct accounts (records for non-company data)",
            "data": {"rows": [{"label": d.label, "value": len(d.units)} for d in sets], "format": "number"}}


def _coverage_by_dataset(sets):
    rows = []
    for d in sets:
        keys = {k for doc in d.docs for k in doc}
        if not keys or not d.docs:
            continue
        share = sum(1 for doc in d.docs for k in keys if doc.get(k) not in (None, "")) / (len(keys) * len(d.docs))
        rows.append({"label": d.label, "value": round(share, 3), "filled": len(keys), "total": len(d.docs)})
    if len(rows) < 2:
        return None
    return {"id": "coverage-datasets", "kind": "coverage", "title": "Data completeness by dataset",
            "subtitle": "Share of filled cells; low coverage means insights skip more accounts",
            "data": {"rows": sorted(rows, key=lambda r: -r["value"])}}


def _opportunities(names):
    from backend.opportunities import use_cases  # local import keeps module load light

    result = use_cases(names, top=0)
    ready = [c for c in result["use_cases"] if c["status"] == "ready"]
    if not ready:
        return None, None
    bar = {"id": "use-cases", "kind": "bar", "title": "Opportunity accounts by use case",
           "subtitle": "Accounts with direct evidence in a value-added field. Open Opportunities for the list.",
           "data": {"rows": [{"label": c["title"], "value": c["accounts"]} for c in ready], "format": "number"}}
    # Sankey: country -> use case (top 5 countries, the rest as Other).
    country_totals = Counter()
    sankey = None
    for case in ready:
        for country in case["by_country"]:
            country_totals[country["label"]] += country["value"]
    top_countries = {c for c, _ in country_totals.most_common(5)}
    first = Counter()
    for case in ready:
        for country in case["by_country"]:
            name = country["label"] if country["label"] in top_countries else "Other countries"
            first[(name, case["title"])] += country["value"]
    if first:
        nodes = sorted({a for a, _ in first}) + [c["title"] for c in ready]
        flows = [{"source": a, "target": b, "value": v} for (a, b), v in first.items()]
        sankey = {"id": "sankey", "kind": "sankey", "title": "Where the opportunities come from",
                  "subtitle": "Country → use case, by number of accounts with evidence (an account can feed "
                              "several use cases)", "wide": True,
                  "data": {"nodes": [{"name": n} for n in nodes], "links": flows}}
    return bar, sankey


# --------------------------------------------------
# Dataset-level charts
# --------------------------------------------------

def _top_categories(d):
    charts = []
    for field in d.categorical()[:2]:
        counts = Counter(u.get(field) for u in d.units if isinstance(u.get(field), str) and u.get(field))
        if len(counts) < 2:
            continue
        top = counts.most_common(TOP)
        rest = sum(counts.values()) - sum(n for _, n in top)
        rows = [{"label": k, "value": v} for k, v in top] + ([{"label": "Other", "value": rest}] if rest else [])
        charts.append({"id": f"cat-{field}", "kind": "bar", "title": f"{profiling.pretty(field)}",
                       "subtitle": f"{'Accounts' if d.company else 'Records'} per value · {len(counts)} distinct",
                       "data": {"rows": rows, "format": "number"}})
    return charts


def _capabilities(d):
    fields = d.roles["capability"]
    if not fields:
        return None, None
    rows = []
    for field in fields:
        yes = sum(1 for u in d.units if u.get(field) is True)
        no = sum(1 for u in d.units if u.get(field) is False)
        unknown = len(d.units) - yes - no
        rows.append({"label": profiling.pretty(field), "field": field, "yes": yes, "no": no, "unknown": unknown})
    rows.sort(key=lambda r: r["yes"] / max(1, r["yes"] + r["no"]))
    stacked = {"id": "capabilities", "kind": "stacked", "title": "Capability adoption",
               "subtitle": "Yes / No / not recorded per account. Lowest adoption first: the biggest gaps lead.",
               "data": {"rows": rows}}
    dumbbell = None
    if d.country_field:
        counts = Counter(d.country_of(u) for u in d.units)
        counts.pop(None, None)
        if counts and len(counts) >= 2:
            lead, n_lead = counts.most_common(1)[0]
            rest_units = [u for u in d.units if d.country_of(u) not in (lead, None)]
            lead_units = [u for u in d.units if d.country_of(u) == lead]
            if len(rest_units) >= 3:
                pairs = []
                for field in fields:
                    def share(units):
                        known = [u.get(field) for u in units if isinstance(u.get(field), bool)]
                        return round(sum(known) / len(known), 3) if known else None
                    a, b = share(lead_units), share(rest_units)
                    if a is not None and b is not None:
                        pairs.append({"label": profiling.pretty(field), "a": a, "b": b})
                if pairs:
                    dumbbell = {"id": "dumbbell", "kind": "dumbbell",
                                "title": f"Adoption: {lead} vs rest of world",
                                "subtitle": f"{len(lead_units)} accounts in {lead} · {len(rest_units)} elsewhere",
                                "data": {"rows": pairs, "a_label": lead, "b_label": "Rest of world"}}
    return stacked, dumbbell


def _measure(d):
    """The measure the deep-dive charts use: financial first, then size, then any numeric field."""

    for field in [d.finance_field, d.size_field]:
        if field:
            return field
    numeric = Counter()
    for u in d.units:
        for k, v in u.items():
            if _num(v) and k != "rows" and not re.search(r"(^|_)(id|year|month|day)$", k, re.I):
                numeric[k] += 1
    return numeric.most_common(1)[0][0] if numeric else None


def _histogram(d, field):
    values = [u.get(field) for u in d.units if _num(u.get(field))]
    missing = len(d.units) - len(values)
    if len(values) < 8:
        return None
    positive = [v for v in values if v > 0]
    log = len(positive) == len(values) and max(values) / max(min(values), 1e-9) > 1000
    bins = []
    if log:
        lo, hi = math.floor(math.log10(min(values))), math.ceil(math.log10(max(values)) + 1e-9)
        for e in range(lo, hi):
            a, b = 10 ** e, 10 ** (e + 1)
            bins.append({"from": a, "to": b, "count": sum(1 for v in values if a <= v < b or (e == hi - 1 and v == b))})
    else:
        lo, hi = min(values), max(values)
        k = min(12, max(5, int(math.sqrt(len(values)))))
        width = (hi - lo) / k or 1
        for i in range(k):
            a, b = lo + i * width, lo + (i + 1) * width
            bins.append({"from": a, "to": b, "count": sum(1 for v in values if a <= v < b or (i == k - 1 and v == b))})
    return {"id": "histogram", "kind": "histogram", "title": f"Distribution of {profiling.pretty(field).lower()}",
            "subtitle": f"{len(values):,} accounts · median {statistics.median(values):,.4g}"
                        + (" · log-scale bins (×10 each)" if log else "")
                        + (f" · {missing:,} without a value" if missing else ""),
            "data": {"bins": bins, "log": log, "median": statistics.median(values), "format": _fmt_for(field)}}


def _box(d, field):
    if not d.country_field:
        return None
    groups = defaultdict(list)
    for u in d.units:
        country = d.country_of(u)
        if country and _num(u.get(field)):
            groups[country].append(u.get(field))
    groups = {k: v for k, v in groups.items() if len(v) >= 3}
    if len(groups) < 2:
        return None
    out = []
    for label, values in sorted(groups.items(), key=lambda kv: -len(kv[1]))[:6]:
        lo, q1, med, q3, hi = _quantiles(values)
        out.append({"label": label, "min": lo, "q1": q1, "median": med, "q3": q3, "max": hi, "n": len(values)})
    log = all(g["min"] > 0 for g in out) and max(g["max"] for g in out) / max(min(g["min"] for g in out), 1e-9) > 1000
    return {"id": "box", "kind": "box", "title": f"{profiling.pretty(field)} by country",
            "subtitle": "Box = middle 50%, line = median, whiskers = min / max. Countries with 3+ accounts.",
            "data": {"groups": out, "log": log, "format": _fmt_for(field)}}


def _scatter(d):
    x_field, y_field = d.size_field, d.finance_field
    if not x_field or not y_field or x_field == y_field:
        numeric = [f for f in d.roles["size"] + d.roles["finance"] + d.roles["rating"] + d.roles["reviews"]]
        numeric = list(dict.fromkeys(numeric))
        if len(numeric) < 2:
            return None
        x_field, y_field = numeric[0], numeric[1]
    name_field = d.roles["name"][0] if d.roles["name"] else None
    points = []
    for u in d.units:
        x, y = u.get(x_field), u.get(y_field)
        if _num(x) and _num(y):
            points.append({"label": str(u.get(name_field) or ""), "x": x, "y": y, "group": d.country_of(u) or "Unknown"})
    if len(points) < 6:
        return None
    log = all(p["x"] > 0 and p["y"] > 0 for p in points)
    groups = Counter(p["group"] for p in points)
    keep = [g for g, _ in groups.most_common(3)]
    for p in points:
        if p["group"] not in keep:
            p["group"] = "Other"
    return {"id": "scatter", "kind": "scatter", "wide": True,
            "title": f"{profiling.pretty(y_field)} vs {profiling.pretty(x_field).lower()}",
            "subtitle": f"{len(points)} accounts with both values" + (" · log scales" if log else ""),
            "data": {"points": points, "x_label": profiling.pretty(x_field), "y_label": profiling.pretty(y_field),
                     "log": log, "x_format": _fmt_for(x_field), "y_format": _fmt_for(y_field),
                     "groups": keep + (["Other"] if any(p["group"] == "Other" for p in points) else [])}}


def _pareto_and_top(d, field):
    name_field = d.roles["name"][0] if d.roles["name"] else None
    if not name_field:
        return None, None
    ranked = sorted(((str(u.get(name_field)), u.get(field), u) for u in d.units if _num(u.get(field)) and u.get(field) > 0),
                    key=lambda t: -t[1])
    if len(ranked) < 5:
        return None, None
    total = sum(v for _, v, _ in ranked)
    running, rows = 0, []
    for label, value, _ in ranked[:20]:
        running += value
        rows.append({"label": label, "value": value, "cum_share": round(running / total, 4)})
    top_n = next((i + 1 for i, r in enumerate(rows) if r["cum_share"] >= 0.8), None)
    pareto = {"id": "pareto", "kind": "pareto", "wide": True,
              "title": f"Concentration of {profiling.pretty(field).lower()}",
              "subtitle": (f"The top {top_n} of {len(ranked)} accounts hold 80%" if top_n
                           else f"The top 20 of {len(ranked)} accounts hold {rows[-1]['cum_share']:.0%}"),
              "data": {"rows": rows, "format": _fmt_for(field), "accounts": len(ranked)}}
    source = field[:-4] if field.endswith("_num") else None
    top = [{"label": label, "value": value, "group": d.country_of(u) or "",
            "shown": u.get(source) if source and isinstance(u.get(source), str) else None}
           for label, value, u in ranked[:TOP]]
    lollipop = {"id": "lollipop", "kind": "lollipop", "title": f"Top {len(top)} accounts by {profiling.pretty(field).lower()}",
                "subtitle": "As written in the source; ranked on the lower bound",
                "data": {"rows": top, "format": _fmt_for(field)}}
    return pareto, lollipop


def _trend(d):
    fields = d.roles["date"] + d.roles["contract_date"]
    if not fields:
        return None
    field = fields[0]
    measure = _measure(d) if not d.company else None
    buckets = defaultdict(float)
    counts = Counter()
    for doc in d.docs:
        text = doc.get(field)
        if not isinstance(text, str) or len(text) < 7:
            continue
        key = text[:7]
        counts[key] += 1
        if measure and _num(doc.get(measure)):
            buckets[key] += doc.get(measure)
    if len(counts) < 3:
        return None
    use_sum = bool(measure and buckets)
    series = sorted((buckets if use_sum else counts).items())
    rows = []
    for i, (label, value) in enumerate(series):
        window = [v for _, v in series[max(0, i - 2): i + 1]]
        rows.append({"label": label, "value": round(value, 2), "avg": round(statistics.fmean(window), 2)})
    first, last = rows[0]["value"], rows[-1]["value"]
    change = f" · {((last - first) / first):+.0%} first → last month" if first else ""
    return {"id": "trend", "kind": "trend", "wide": True,
            "title": f"{profiling.pretty(measure) if use_sum else 'Records'} by month",
            "subtitle": f"By {profiling.pretty(field).lower()} · line = 3-month moving average{change}",
            "data": {"rows": rows, "format": _fmt_for(measure) if use_sum else "number"}}


def _coverage_fields(d):
    keys = []
    for doc in d.docs:
        for k in doc:
            if k not in keys:
                keys.append(k)
    if not keys:
        return None
    rows = []
    for k in keys:
        filled = sum(1 for doc in d.docs if doc.get(k) not in (None, ""))
        rows.append({"label": profiling.pretty(k) + (" (derived)" if k.endswith(("_num", "_flag")) else ""),
                     "value": round(filled / len(d.docs), 3), "filled": filled, "total": len(d.docs),
                     "derived": k.endswith(("_num", "_flag"))})
    rows.sort(key=lambda r: r["value"])
    return {"id": "coverage", "kind": "coverage", "title": "Field coverage",
            "subtitle": "Share of rows with a value. Fields under 50% limit what can be concluded.",
            "data": {"rows": rows[:24]}}


# --------------------------------------------------
# Headlines: one plain sentence per chart, computed from its own data
# --------------------------------------------------

def _pct(v):
    return f"{v:.0%}"


def _short_num(v):
    if abs(v) >= 1e9:
        return f"{v / 1e9:.1f}B"
    if abs(v) >= 1e6:
        return f"{v / 1e6:.1f}M"
    if abs(v) >= 1e4:
        return f"{v / 1e3:.0f}K"
    if float(v).is_integer() or abs(v) >= 100:
        return f"{v:,.0f}"
    return f"{v:,.2f}"


def _pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sx = sum((x - mx) ** 2 for x in xs) ** 0.5
    sy = sum((y - my) ** 2 for y in ys) ** 0.5
    if not sx or not sy:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)


def headline(chart):
    """A one-line takeaway for a chart, from the chart's own numbers (no model)."""

    kind, d = chart["kind"], chart["data"]
    try:
        if kind in {"bar", "coverage"} and d.get("rows"):
            rows = d["rows"]
            if kind == "coverage":
                low = min(rows, key=lambda r: r["value"])
                if low["value"] >= 0.995:
                    return "Every field is fully filled"
                return f"Weakest: {low['label']} is filled for only {_pct(low['value'])} of rows"
            top = max(rows, key=lambda r: r["value"])
            total = sum(r["value"] for r in rows) or 1
            if chart["id"].startswith("cat-"):
                return f"{chart['title']}: {top['label']} is the most common ({_pct(top['value'] / total)})"
            return f"{top['label']} leads with {_pct(top['value'] / total)} of the total"
        if kind == "map" and d.get("places"):
            places = [p for p in d["places"] if p.get("value")]
            top = max(places, key=lambda p: p["value"])
            total = sum(p["value"] for p in places) or 1
            return f"{top['name']} holds {_pct(top['value'] / total)} of all {d.get('metric', 'records').lower()}"
        if kind == "heatmap":
            best = max(((r, c, d["cells"][i][j]) for i, r in enumerate(d["rows"]) for j, c in enumerate(d["cols"])),
                       key=lambda t: t[2])
            return f"Densest spot: {best[0]} in {best[1]} ({best[2]:,})"
        if kind == "treemap":
            groups = [(g["name"], sum(c.get("value", 0) for c in g.get("children", []))) for g in d["children"]]
            name, value = max(groups, key=lambda g: g[1])
            total = sum(v for _, v in groups) or 1
            return f"{name} is the largest part, {_pct(value / total)} of everything"
        if kind == "histogram":
            peak = max(d["bins"], key=lambda b: b["count"])
            return f"Most values sit between {_short_num(peak['from'])} and {_short_num(peak['to'])}; median {_short_num(d['median'])}"
        if kind == "box":
            top = max(d["groups"], key=lambda g: g["median"])
            return f"{top['label']} has the highest typical value (median {_short_num(top['median'])})"
        if kind == "scatter":
            import math
            pts = [p for p in d["points"] if p["x"] > 0 and p["y"] > 0] if d.get("log") else d["points"]
            xs = [math.log10(p["x"]) if d.get("log") else p["x"] for p in pts]
            ys = [math.log10(p["y"]) if d.get("log") else p["y"] for p in pts]
            r = _pearson(xs, ys)
            if r is None:
                return None
            strength = "strongly" if abs(r) >= 0.6 else "somewhat" if abs(r) >= 0.3 else "barely"
            direction = "rises" if r >= 0 else "falls"
            return f"{d['y_label']} {strength} {direction} with {d['x_label'].lower()} (r = {r:.2f})"
        if kind == "pareto":
            return chart.get("subtitle")
        if kind == "lollipop" and d.get("rows"):
            top = d["rows"][0]
            return f"{top['label']} ranks first ({top.get('shown') or _short_num(top['value'])})"
        if kind == "trend" and len(d.get("rows", [])) >= 2:
            first, last = d["rows"][0], d["rows"][-1]
            peak = max(d["rows"], key=lambda r: r["value"])
            change = (last["value"] - first["value"]) / first["value"] if first["value"] else None
            moved = f"{'up' if change >= 0 else 'down'} {abs(change):.0%} from {first['label']}" if change is not None else ""
            return f"Peak in {peak['label']}; {moved}".strip("; ")
        if kind == "stacked" and d.get("rows"):
            gap = max(d["rows"], key=lambda r: r["no"])
            return f"Biggest gap: {gap['no']} accounts have no {gap['label'].lower()}"
        if kind == "dumbbell" and d.get("rows"):
            far = max(d["rows"], key=lambda r: abs(r["a"] - r["b"]))
            return f"{far['label']}: {d['a_label']} {_pct(far['a'])} vs {d['b_label'].lower()} {_pct(far['b'])}"
        if kind == "sankey" and d.get("links"):
            big = max(d["links"], key=lambda l: l["value"])
            return f"Strongest flow: {big['source']} → {big['target']} ({big['value']} accounts)"
    except (KeyError, ValueError, ZeroDivisionError, TypeError):
        return None
    return None


# --------------------------------------------------
# Entry point
# --------------------------------------------------

def build(collection=None):
    names = business_collection_names()  # already limited to the caller's scope
    if collection:
        if collection not in names:
            raise ValueError("That dataset is not available in this scope.")
        names = [collection]
    sets = [Dataset(n) for n in names]
    sets = [d for d in sets if d.docs]
    if not sets:
        return {"scope": [], "kpis": [], "charts": [], "datasets": []}

    charts = []
    if len(sets) > 1:
        charts += [_map(sets), _heatmap(sets), _treemap(sets), _dataset_bar(sets), _coverage_by_dataset(sets)]
        if any(d.company for d in sets):
            bar, sankey = _opportunities([d.name for d in sets])
            charts += [bar, sankey]
    else:
        d = sets[0]
        measure = _measure(d)
        stacked, dumbbell = _capabilities(d)
        pareto, lollipop = _pareto_and_top(d, measure) if measure else (None, None)
        charts += [_map(sets), *_top_categories(d), stacked, dumbbell,
                   _histogram(d, measure) if measure else None, _box(d, measure) if measure else None,
                   _scatter(d), pareto, lollipop, _trend(d), _coverage_fields(d)]
        if d.company:
            bar, _ = _opportunities([d.name])
            charts.append(bar)

    return {
        "scope": [d.label for d in sets],
        "datasets": [{"name": d.name, "label": d.label, "rows": len(d.docs), "accounts": len(d.units),
                      "company": d.company} for d in sets],
        "kpis": _kpis(sets),
        "charts": [{**c, "headline": headline(c)} for c in charts if c],
    }
