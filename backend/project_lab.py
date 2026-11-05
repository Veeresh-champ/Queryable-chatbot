"""Analytics lab for any project (VAF samples and future uploads).

The SPAN and IBM HR labs (``analytics.lab`` / ``hr_analytics.lab``) are built
for those two fixed schemas. This one works from field roles
(``backend.profiling``) and the opportunity engine, so any company-level
project gets the same depth: one record per account with its size and
financial percentile, capabilities and the use cases it qualifies for, plus
the matrices the animated views need. Every value comes from MongoDB; missing
values stay ``None`` and are shown as unknown.
"""

from collections import Counter

from backend import profiling
from backend.db import business_collection_names
from backend.opportunities import USE_CASES, Context, _supported, evidence

MAX_ACCOUNTS = 600
TOP_COUNTRIES = 8


def _completeness(records, fields):
    if not records or not fields:
        return 0.0
    filled = sum(1 for r in records for f in fields if r.get(f) not in (None, ""))
    return filled / (len(records) * len(fields))


def lab(collections=None):
    collections = collections if collections is not None else business_collection_names()
    ctx = Context(collections)
    if not ctx.records:
        return {"available": False, "reason": "No company-level dataset in this scope (a dataset needs a company name field).",
                "datasets": [], "accounts": []}

    case_titles = {c["id"]: c["title"] for c in USE_CASES}
    accounts, case_counts = [], Counter()
    for index, account in enumerate(ctx.records):
        info = account["dataset"]
        cases = [cid for cid in case_titles if _supported(cid, info) and evidence(cid, account, ctx)]
        case_counts.update(cases)
        caps = {profiling.pretty(f): account["record"].get(f) for f in info["roles"]["capability"]}
        accounts.append({
            "id": index,
            "name": account["name"],
            "country": account["country"],
            "dataset": info["name"],
            "label": info["label"],
            "size": round(account["size_rank"], 3) if account["size_rank"] is not None else None,
            "finance": round(account["finance_rank"], 3) if account["finance_rank"] is not None else None,
            "size_band": account["size_band"],
            "growth": ctx.growth(account),
            "cases": cases,
            "capabilities": {k: v for k, v in caps.items() if isinstance(v, bool)},
        })

    datasets = []
    for info in ctx.datasets:
        records = [a["record"] for a in ctx.records if a["dataset"] is info]
        fields = sorted({k for r in records for k in r if k != "rows"})
        datasets.append({"name": info["name"], "label": info["label"], "accounts": info["accounts"],
                         "rows": info["rows"], "completeness": round(_completeness(records, fields), 3),
                         "fields": len(fields), "size_field": profiling.pretty(info["size_field"]) if info["size_field"] else None})

    # Chord: countries (top N + Other) <-> datasets, weighted by accounts.
    country_totals = Counter(a["country"] or "Unknown" for a in accounts)
    top = [c for c, _ in country_totals.most_common(TOP_COUNTRIES) if c != "Unknown"]
    countries = top + (["Other"] if len(country_totals) > len(top) else [])
    labels = [d["label"] for d in datasets]
    names = countries + labels
    n = len(names)
    matrix = [[0] * n for _ in range(n)]
    for a in accounts:
        c = a["country"] if a["country"] in top else "Other"
        if c not in countries:
            continue
        i, j = names.index(c), names.index(a["label"])
        matrix[i][j] += 1
        matrix[j][i] += 1

    # Capability waffle: per dataset and capability, every account's answer.
    waffle = []
    for info in ctx.datasets:
        for field in info["roles"]["capability"]:
            cells = [a["record"].get(field) for a in ctx.records if a["dataset"] is info]
            waffle.append({"dataset": info["label"], "capability": profiling.pretty(field),
                           "cells": [None if not isinstance(v, bool) else v for v in cells]})

    ranked = sorted((a for a in accounts if a["size"] is not None),
                    key=lambda a: (-(a["size"] + (a["finance"] or 0)), a["name"] or ""))
    with_cases = sum(1 for a in accounts if a["cases"])
    kpis = [
        {"id": "accounts", "label": "Accounts", "value": len(accounts), "format": "number", "hint": f"in {len(datasets)} datasets"},
        {"id": "countries", "label": "Countries", "value": len({a['country'] for a in accounts if a['country']}),
         "format": "number", "hint": "with a recognised country"},
        {"id": "opportunity", "label": "With an opportunity", "value": round(with_cases / len(accounts), 3),
         "format": "percent", "hint": f"{with_cases} accounts have use-case evidence"},
        {"id": "completeness", "label": "Data completeness", "format": "percent",
         "value": round(sum(d["completeness"] * d["accounts"] for d in datasets) / max(1, sum(d["accounts"] for d in datasets)), 3),
         "hint": "share of filled fields"},
    ]
    best = case_counts.most_common(1)
    briefing = (
        f"{len(accounts)} accounts across {len(datasets)} datasets and {kpis[1]['value']} countries. "
        + (f"The largest opportunity is {case_titles[best[0][0]].lower()} ({best[0][1]} accounts). " if best else "")
        + f"{with_cases} accounts ({with_cases / len(accounts):.0%}) show evidence for at least one use case."
    )
    return {
        "available": True,
        "briefing": briefing,
        "kpis": kpis,
        "datasets": datasets,
        "use_cases": [{"id": cid, "title": case_titles[cid], "accounts": n} for cid, n in case_counts.most_common()],
        "accounts": accounts[:MAX_ACCOUNTS],
        "truncated": len(accounts) > MAX_ACCOUNTS,
        "chord": {"names": names, "groups": ["country"] * len(countries) + ["dataset"] * len(labels), "matrix": matrix},
        "waffle": waffle,
        "top": [{"name": a["name"], "label": a["label"], "country": a["country"], "size": a["size"], "finance": a["finance"]}
                for a in ranked[:24]],
    }


# --------------------------------------------------
# Per-dataset deep dive (any dataset: companies, employees, orders, sales)
# --------------------------------------------------

import math
import re
import statistics

_OUTCOME = re.compile(r"(attrition|churn|status|outcome|converted|left|default|won|lost|active|renew)", re.IGNORECASE)
_POSITIVE = {"yes", "true", "left", "churned", "completed", "won", "active", "converted"}


def _top(values, n):
    counts = Counter(v for v in values if isinstance(v, str) and v)
    return [k for k, _ in counts.most_common(n)]


def _sunburst(ds, outer, inner):
    top_outer = _top([u.get(outer) for u in ds.units], 8)
    top_inner = _top([u.get(inner) for u in ds.units], 6) if inner else []
    tree = {}
    for u in ds.units:
        a = u.get(outer)
        if not isinstance(a, str) or not a:
            continue
        a = a if a in top_outer else "Other"
        b = u.get(inner) if inner else None
        b = (b if b in top_inner else "Other") if isinstance(b, str) and b else ("All" if not inner else "Not recorded")
        tree.setdefault(a, Counter())[b] += 1
    return {"name": "All", "outer": profiling.pretty(outer), "inner": profiling.pretty(inner) if inner else None,
            "children": [{"name": a, "children": [{"name": b, "value": n} for b, n in kids.most_common()]}
                         for a, kids in sorted(tree.items(), key=lambda kv: -sum(kv[1].values()))]}


def _outcome_field(ds):
    """(field, positive value) of a yes/no outcome with real variation, or None."""

    candidates = []
    keys = {k for doc in ds.docs[:200] for k in doc}
    for field in keys:
        values = [d.get(field) for d in ds.docs if d.get(field) is not None]
        if not values:
            continue
        if all(isinstance(v, bool) for v in values):
            candidates.append((field, True))
        elif all(isinstance(v, str) for v in values):
            distinct = {v.strip().lower() for v in values}
            if len(distinct) == 2 and distinct & _POSITIVE:
                positive = next(v for v in {v.strip() for v in values} if v.lower() in _POSITIVE)
                candidates.append((field, positive))
    def rate(field, positive):
        values = [d.get(field) for d in ds.docs if d.get(field) is not None]
        hits = sum(1 for v in values if (v is True if positive is True else isinstance(v, str) and v.strip() == positive))
        return hits / len(values) if values else 0

    candidates = [c for c in candidates if 0.03 <= rate(*c) <= 0.97]
    if not candidates:
        return None
    candidates.sort(key=lambda c: (not _OUTCOME.search(c[0]), c[0].endswith("_flag")))
    return candidates[0]


def _outcome(ds, outcome, by_field):
    if not outcome or not by_field or outcome[0] == by_field:
        return None
    field, positive = outcome

    def hit(v):
        return v is True if positive is True else (isinstance(v, str) and v.strip() == positive)

    groups = {}
    for u in ds.units:
        label, v = u.get(by_field), u.get(field)
        if isinstance(label, str) and label and v is not None:
            g = groups.setdefault(label, [0, 0])
            g[0] += 1
            g[1] += 1 if hit(v) else 0
    rows = sorted(({"label": k, "n": n, "rate": round(h / n, 4)} for k, (n, h) in groups.items() if n >= 3),
                  key=lambda r: -r["n"])[:10]
    if len(rows) < 2:
        return None
    total = sum(g[0] for g in groups.values())
    hits = sum(g[1] for g in groups.values())
    return {"field": profiling.pretty(field), "positive": "Yes" if positive is True else positive,
            "by": profiling.pretty(by_field), "overall": round(hits / total, 4) if total else 0, "rows": rows}


def _numeric_fields(ds, limit=10):
    counts = Counter()
    for u in ds.units:
        for k, v in u.items():
            if k != "rows" and isinstance(v, (int, float)) and not isinstance(v, bool) and \
                    not re.search(r"(^|_)(id|number|count)$|employeecount|standardhours", k, re.IGNORECASE):
                counts[k] += 1
    fields = [k for k, n in counts.most_common() if n >= 10]
    # Skip constants (no variation, nothing to correlate).
    keep = []
    for f in fields:
        values = {u.get(f) for u in ds.units if u.get(f) is not None}
        if len(values) > 2:
            keep.append(f)
    return keep[:limit]


def _correlations(ds):
    fields = _numeric_fields(ds)
    if len(fields) < 2:
        return None
    links = []
    for i, a in enumerate(fields):
        for b in fields[i + 1:]:
            pairs = [(u[a], u[b]) for u in ds.units
                     if isinstance(u.get(a), (int, float)) and isinstance(u.get(b), (int, float))]
            if len(pairs) < 10:
                continue
            xs, ys = zip(*pairs)
            try:
                r = statistics.correlation(xs, ys)
            except statistics.StatisticsError:
                continue
            if abs(r) >= 0.1:
                links.append({"a": profiling.pretty(a), "b": profiling.pretty(b), "r": round(r, 3), "n": len(pairs)})
    if not links:
        return None
    return {"fields": [profiling.pretty(f) for f in fields], "links": sorted(links, key=lambda l: -abs(l["r"]))[:24]}


def _ridges(ds, measure, by_field):
    if not measure:
        return None
    values = [u.get(measure) for u in ds.units if isinstance(u.get(measure), (int, float)) and not isinstance(u.get(measure), bool)]
    if len(values) < 12:
        return None
    log = min(values) > 0 and max(values) / min(values) > 1000
    tx = (lambda v: math.log10(v)) if log else (lambda v: v)
    lo, hi = tx(min(values)), tx(max(values))
    if hi <= lo:
        return None
    bins = 24
    groups = []
    labels = _top([u.get(by_field) for u in ds.units], 6) if by_field else ["All records"]
    for label in labels:
        own = [tx(u[measure]) for u in ds.units if (not by_field or u.get(by_field) == label) and isinstance(u.get(measure), (int, float))
               and not isinstance(u.get(measure), bool) and (u[measure] > 0 or not log)]
        if len(own) < 3:
            continue
        counts = [0] * bins
        for v in own:
            counts[min(bins - 1, int((v - lo) / (hi - lo) * bins))] += 1
        smooth = [(counts[max(0, i - 1)] + 2 * counts[i] + counts[min(bins - 1, i + 1)]) / 4 for i in range(bins)]
        peak = max(smooth) or 1
        groups.append({"label": label, "n": len(own), "median": statistics.median(own),
                       "density": [round(v / peak, 3) for v in smooth]})
    if len(groups) < (2 if by_field else 1):
        return None
    ticks = [lo + (hi - lo) * t for t in (0, 0.25, 0.5, 0.75, 1)]
    return {"measure": profiling.pretty(measure), "by": profiling.pretty(by_field) if by_field else "all records", "log": log,
            "ticks": [round(10 ** t if log else t, 2) for t in ticks], "lo": lo, "hi": hi,
            "groups": [{**g, "median": round(10 ** g["median"] if log else g["median"], 2),
                        "position": (g["median"] - lo) / (hi - lo)} for g in groups]}


def _spiral(ds, measure):
    from backend.dashboard import _trend

    trend = _trend(ds)
    if not trend:
        return None
    return {"title": trend["title"], "format": trend["data"]["format"],
            "rows": [{"label": r["label"], "value": r["value"]} for r in trend["data"]["rows"]]}


def _swarm(ds, measure, by_field):
    if not by_field:
        return None
    groups = _top([u.get(by_field) for u in ds.units], 6)
    values = [u.get(measure) for u in ds.units] if measure else []
    rank = profiling.percentile_rank(values) if measure else (lambda v: None)
    name_field = ds.roles["name"][0] if ds.roles["name"] else None
    dots = []
    for i, u in enumerate(ds.units[:900]):
        label = u.get(by_field)
        group = label if label in groups else "Other"
        dots.append({"id": i, "group": group, "size": rank(u.get(measure)) if measure else None,
                     "name": str(u.get(name_field)) if name_field and u.get(name_field) else None,
                     "value": u.get(measure) if measure and isinstance(u.get(measure), (int, float)) else None})
    return {"by": profiling.pretty(by_field), "measure": profiling.pretty(measure) if measure else None,
            "groups": groups + (["Other"] if any(d["group"] == "Other" for d in dots) else []), "dots": dots,
            "truncated": len(ds.units) > 900}


def dataset_lab(collection):
    """Animated deep-dive data for one dataset in the caller's scope."""

    from backend.dashboard import Dataset, _measure

    if collection not in business_collection_names():
        raise ValueError("That dataset is not available in this scope.")
    ds = Dataset(collection)
    if not ds.docs:
        return {"available": False, "reason": "This dataset has no rows."}
    outcome = _outcome_field(ds)
    cats = [c for c in ds.categorical() if not outcome or c != outcome[0]]
    if ds.country_field:
        cats = [ds.country_field] + [c for c in cats if c != ds.country_field]
    by_field = cats[0] if cats else None
    outcome_by = next((c for c in cats if c != ds.country_field), by_field)
    measure = _measure(ds)
    keys = sorted({k for d in ds.docs for k in d})
    filled = sum(1 for d in ds.docs for k in keys if d.get(k) not in (None, ""))
    kpis = [
        {"id": "records", "label": "Accounts" if ds.company else "Records", "value": len(ds.units), "format": "number",
         "hint": f"{len(ds.docs):,} rows" if ds.company else f"in {ds.label}"},
        {"id": "fields", "label": "Fields", "value": len(keys), "format": "number", "hint": "columns with data"},
        {"id": "groups", "label": f"{profiling.pretty(by_field)} values" if by_field else "Groups",
         "value": len({u.get(by_field) for u in ds.units if u.get(by_field)}) if by_field else 0, "format": "number",
         "hint": "distinct"},
        {"id": "completeness", "label": "Completeness", "value": round(filled / (len(keys) * len(ds.docs)), 3),
         "format": "percent", "hint": "filled cells"},
    ]
    return {
        "available": True,
        "name": collection,
        "label": ds.label,
        "kpis": kpis,
        "sunburst": _sunburst(ds, by_field, cats[1] if len(cats) > 1 else None) if by_field else None,
        "outcome": _outcome(ds, outcome, outcome_by),
        "correlations": _correlations(ds),
        "ridges": _ridges(ds, measure, by_field),
        "spiral": _spiral(ds, measure),
        "swarm": _swarm(ds, measure, by_field),
    }
