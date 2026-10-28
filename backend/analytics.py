"""Analytics lab: relationship views and statistics (no LLM call, every number from MongoDB).

``lab()`` reads the SPAN companies and the monthly sales once and returns
everything the Analytics lab page draws:

* flow      Country → Industry → Deployment spend flow (Sankey)
* network   Industry ↔ HR technology adoption graph (force layout)
* chord     Country ↔ technology category connections (chord diagram)
* segments  k-means company segments (size × spend intensity) with readable names
* drivers   Variance in spend explained by size, industry, country, tool, deployment
* streams   Monthly revenue per product category
* briefing  A plain-language summary built from the numbers above
* heatmap   Average spend per industry × deployment type
* scatter   Company size vs spend, with a log-log regression
* pareto    Cumulative spend share, 80/20 point and Gini coefficient
* outliers  Companies spending most above / below what their size predicts
* revenue   Monthly revenue, 3-month moving average and a 3-month forecast
* insights  Plain-language findings derived from the numbers above
"""

import math
import re
import statistics
from collections import defaultdict

from backend.config import settings
from backend.db import db
from backend.insights import _category_insights, _pretty, _time_insights, label_value_rows
from backend.schema_discovery import get_schema

MAX_TIME_MS = settings.mongo_max_time_ms
SPAN_FIELDS = ("company_name", "industry", "country", "employee_count", "hr_technology",
               "technology_category", "deployment_type", "annual_hr_tech_spend_usd")
NUMERIC_FIELDS = ("employee_count", "annual_hr_tech_spend_usd")
TOP_COUNTRIES = 7


def _fmt_money(value):
    if abs(value) >= 1_000_000:
        return f"${value / 1_000_000:.1f}M"
    if abs(value) >= 1_000:
        return f"${value / 1_000:.0f}K"
    return f"${value:,.0f}"


def _companies():
    projection = {"_id": 0, **{f: 1 for f in SPAN_FIELDS}}
    rows = []
    for doc in db.span_companies.find({}, projection, max_time_ms=MAX_TIME_MS).limit(5000):
        spend, size = doc.get("annual_hr_tech_spend_usd"), doc.get("employee_count")
        if not isinstance(spend, (int, float)) or not isinstance(size, (int, float)) or size <= 0:
            continue
        labels = {f: str(doc.get(f) or "Unknown") for f in SPAN_FIELDS if f not in NUMERIC_FIELDS}
        rows.append({**labels, "spend": float(spend), "employees": float(size)})
    return rows


def _pearson(xs, ys):
    if len(xs) < 3:
        return 0.0
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    return sxy / math.sqrt(sxx * syy) if sxx and syy else 0.0


def _fit(xs, ys):
    """Least-squares line: (slope, intercept)."""

    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else 0.0
    return slope, my - slope * mx


def _gini(values):
    values = sorted(values)
    n, total = len(values), sum(values)
    if not n or not total:
        return 0.0
    weighted = sum((i + 1) * v for i, v in enumerate(values))
    return (2 * weighted) / (n * total) - (n + 1) / n


# ---------------------------------------------------------------- relationship views

def _flow(rows):
    by_country = defaultdict(float)
    for r in rows:
        by_country[r["country"]] += r["spend"]
    top = set(sorted(by_country, key=by_country.get, reverse=True)[:TOP_COUNTRIES])

    def country(r):
        return r["country"] if r["country"] in top else "Other countries"

    links = defaultdict(lambda: [0.0, 0])
    for r in rows:
        for a, b in ((f"c:{country(r)}", f"i:{r['industry']}"), (f"i:{r['industry']}", f"d:{r['deployment_type']}")):
            links[(a, b)][0] += r["spend"]
            links[(a, b)][1] += 1
    names = {key for pair in links for key in pair}
    stage = {"c": 0, "i": 1, "d": 2}
    nodes = [{"id": n, "name": n[2:], "stage": stage[n[0]]} for n in sorted(names)]
    return {
        "stages": ["Country", "Industry", "Deployment"],
        "nodes": nodes,
        "links": [{"source": a, "target": b, "value": round(v, 2), "companies": c}
                  for (a, b), (v, c) in links.items()],
    }


def _network(rows):
    pair = defaultdict(lambda: [0, 0.0])
    industry, tech = defaultdict(lambda: [0, 0.0]), defaultdict(lambda: [0, 0.0])
    for r in rows:
        for bucket, key in ((pair, (r["industry"], r["hr_technology"])), (industry, r["industry"]),
                            (tech, r["hr_technology"])):
            bucket[key][0] += 1
            bucket[key][1] += r["spend"]
    nodes = [{"id": f"i:{k}", "name": k, "group": "industry", "companies": c, "spend": round(s, 2)}
             for k, (c, s) in industry.items()]
    nodes += [{"id": f"t:{k}", "name": k, "group": "technology", "companies": c, "spend": round(s, 2)}
              for k, (c, s) in tech.items()]
    links = [{"source": f"i:{a}", "target": f"t:{b}", "companies": c, "spend": round(s, 2)}
             for (a, b), (c, s) in pair.items()]
    return {"nodes": nodes, "links": links}


def _chord(rows):
    countries = sorted({r["country"] for r in rows})
    categories = sorted({r["technology_category"] for r in rows})
    names = countries + categories
    index = {name: i for i, name in enumerate(names)}
    matrix = [[0.0] * len(names) for _ in names]
    for r in rows:
        a, b = index[r["country"]], index[r["technology_category"]]
        matrix[a][b] += r["spend"]
        matrix[b][a] += r["spend"]
    return {"names": names, "groups": ["country"] * len(countries) + ["category"] * len(categories),
            "matrix": [[round(v, 2) for v in row] for row in matrix]}


def _heatmap(rows):
    rows_axis = sorted({r["industry"] for r in rows})
    cols_axis = sorted({r["deployment_type"] for r in rows})
    cells = defaultdict(list)
    for r in rows:
        cells[(r["industry"], r["deployment_type"])].append(r["spend"])
    return {
        "rows": rows_axis,
        "cols": cols_axis,
        "cells": [{"row": a, "col": b, "value": round(statistics.fmean(v), 2), "companies": len(v)}
                  for (a, b), v in cells.items()],
    }


# ---------------------------------------------------------------- statistics

def _scatter(rows):
    xs = [math.log10(r["employees"]) for r in rows]
    ys = [math.log10(max(r["spend"], 1)) for r in rows]
    slope, intercept = _fit(xs, ys)
    r = _pearson(xs, ys)
    return {
        "points": [{"name": r_["company_name"], "industry": r_["industry"], "country": r_["country"],
                    "technology": r_["hr_technology"], "category": r_["technology_category"],
                    "deployment": r_["deployment_type"], "employees": r_["employees"], "spend": r_["spend"]}
                   for r_ in rows],
        "fit": {"slope": round(slope, 4), "intercept": round(intercept, 4), "r": round(r, 4), "r2": round(r * r, 4)},
    }


def _pareto(rows):
    spends = sorted((r["spend"] for r in rows), reverse=True)
    total = sum(spends) or 1
    curve, running, eighty_at = [], 0.0, None
    step = max(1, len(spends) // 100)
    for i, s in enumerate(spends, start=1):
        running += s
        if eighty_at is None and running / total >= 0.8:
            eighty_at = i
        if i % step == 0 or i == len(spends):
            curve.append({"x": round(i / len(spends), 4), "y": round(running / total, 4)})
    return {
        "curve": [{"x": 0, "y": 0}] + curve,
        "companies_for_80": eighty_at,
        "share_for_80": round((eighty_at or 0) / len(spends), 4) if spends else 0,
        "top10_share": round(sum(spends[: max(1, len(spends) // 10)]) / total, 4),
        "gini": round(_gini(spends), 4),
    }


def _outliers(rows, fit):
    """Companies furthest above / below the spend their size predicts (log-log fit)."""

    scored = []
    for r in rows:
        predicted = 10 ** (fit["slope"] * math.log10(r["employees"]) + fit["intercept"])
        scored.append({"name": r["company_name"], "industry": r["industry"], "country": r["country"],
                       "employees": r["employees"], "spend": r["spend"], "expected": round(predicted, 2),
                       "ratio": round(r["spend"] / predicted, 3)})
    scored.sort(key=lambda o: o["ratio"], reverse=True)
    return {
        "median_per_employee": round(statistics.median(r["spend"] / r["employees"] for r in rows), 2),
        "over": scored[:5],
        "under": scored[::-1][:5],
    }


def _efficiency(rows):
    groups = defaultdict(lambda: [0.0, 0.0, 0])
    for r in rows:
        g = groups[r["industry"]]
        g[0] += r["spend"]
        g[1] += r["employees"]
        g[2] += 1
    return sorted(({"label": k, "value": round(s / e, 2), "companies": c} for k, (s, e, c) in groups.items()),
                  key=lambda x: x["value"], reverse=True)


def _revenue():
    if "sales_cleaned" not in get_schema():
        return None
    rows = list(db.sales_cleaned.aggregate([
        {"$group": {"_id": {"year": "$year", "month": "$month"}, "value": {"$sum": "$Revenue"},
                    "orders": {"$sum": 1}}},
        {"$sort": {"_id.year": 1, "_id.month": 1}},
    ], maxTimeMS=MAX_TIME_MS))
    series = [{"label": f"{r['_id']['year']}-{int(r['_id']['month']):02d}", "value": round(float(r["value"]), 2),
               "orders": r["orders"]} for r in rows if r["_id"].get("year") and r["_id"].get("month")]
    if len(series) < 4:
        return None
    values = [p["value"] for p in series]
    for i, p in enumerate(series):
        window = values[max(0, i - 2): i + 1]
        p["moving_avg"] = round(statistics.fmean(window), 2)
    xs = list(range(len(values)))
    slope, intercept = _fit(xs, values)
    sigma = statistics.pstdev([v - (slope * x + intercept) for x, v in zip(xs, values)])
    year, month = map(int, series[-1]["label"].split("-"))
    forecast = []
    for step in range(1, 4):
        month += 1
        if month > 12:
            year, month = year + 1, 1
        x = len(values) - 1 + step
        estimate = slope * x + intercept
        forecast.append({"label": f"{year}-{month:02d}", "value": round(estimate, 2),
                         "low": round(estimate - 1.28 * sigma, 2), "high": round(estimate + 1.28 * sigma, 2)})
    growth = [(values[i] - values[i - 1]) / values[i - 1] for i in range(1, len(values)) if values[i - 1]]
    return {
        "series": series,
        "forecast": forecast,
        "slope_per_month": round(slope, 2),
        "volatility": round(statistics.pstdev(growth), 4) if growth else 0,
        "best": max(series, key=lambda p: p["value"]),
        "worst": min(series, key=lambda p: p["value"]),
    }


# ---------------------------------------------------------------- narrative

def _insights(rows, flow, network, heatmap, scatter, pareto, outliers, efficiency, revenue):
    out = []
    total = sum(r["spend"] for r in rows)

    country_spend = defaultdict(float)
    for link in flow["links"]:
        if link["source"].startswith("c:"):
            country_spend[link["source"][2:]] += link["value"]
    lead = max(country_spend, key=country_spend.get)
    out.append({"kind": "leader", "title": f"{lead} carries {country_spend[lead] / total:.0%} of all spend",
                "detail": f"{_fmt_money(country_spend[lead])} of {_fmt_money(total)} flows through one market",
                "view": "flow"})

    out.append({"kind": "concentration",
                "title": f"{pareto['share_for_80']:.0%} of companies drive 80% of spend",
                "detail": f"Gini {pareto['gini']:.2f}; the top 10% alone account for {pareto['top10_share']:.0%}",
                "view": "pareto"})

    fit = scatter["fit"]
    strength = "strongly" if abs(fit["r"]) >= 0.7 else "moderately" if abs(fit["r"]) >= 0.4 else "weakly"
    out.append({"kind": "correlation", "title": f"Company size {strength} predicts spend (r = {fit['r']:.2f})",
                "detail": f"Spend grows {fit['slope']:.2f}% for every 1% more employees; "
                          f"size explains {fit['r2']:.0%} of the variation",
                "view": "scatter"})

    best_cell = max(heatmap["cells"], key=lambda c: c["value"])
    out.append({"kind": "hotspot", "title": f"{best_cell['row']} on {best_cell['col']} is the priciest pairing",
                "detail": f"Average {_fmt_money(best_cell['value'])} per company across {best_cell['companies']} companies",
                "view": "heatmap"})

    tech = max((n for n in network["nodes"] if n["group"] == "technology"), key=lambda n: n["companies"])
    reach = sum(1 for link in network["links"] if link["target"] == tech["id"])
    out.append({"kind": "network", "title": f"{tech['name']} is the most connected tool",
                "detail": f"Used by {tech['companies']} companies across {reach} industries",
                "view": "network"})

    if efficiency:
        hi, lo = efficiency[0], efficiency[-1]
        out.append({"kind": "efficiency", "title": f"{hi['label']} spends {hi['value'] / lo['value']:.1f}× more per employee",
                    "detail": f"${hi['value']:,.0f} per head vs ${lo['value']:,.0f} in {lo['label']}",
                    "view": "efficiency"})

    if outliers["over"]:
        top, low = outliers["over"][0], outliers["under"][0]
        out.append({"kind": "outlier", "title": f"{top['name']} spends {top['ratio']:.1f}× what its size predicts",
                    "detail": f"At the other end, {low['name']} spends {1 / low['ratio']:.1f}× less than expected",
                    "view": "outliers"})

    if revenue:
        direction = "rising" if revenue["slope_per_month"] >= 0 else "easing"
        out.append({"kind": "forecast", "title": f"Revenue trend is {direction} ({revenue['slope_per_month']:+,.0f}/month)",
                    "detail": f"Next month projected at {_fmt_money(revenue['forecast'][0]['value'])}; "
                              f"peak was {revenue['best']['label']}",
                    "view": "revenue"})
    return out


# ---------------------------------------------------------------- machine-learning views

def _kmeans(vectors, k, seed=7, rounds=60):
    """Plain k-means with k-means++ seeding (deterministic). Returns (labels, centroids)."""

    import random

    rng = random.Random(seed)
    centroids = [vectors[rng.randrange(len(vectors))]]
    while len(centroids) < k:
        dist = [min(sum((a - b) ** 2 for a, b in zip(v, c)) for c in centroids) for v in vectors]
        pick, acc, target = 0, 0.0, rng.random() * sum(dist)
        for i, d in enumerate(dist):
            acc += d
            if acc >= target:
                pick = i
                break
        centroids.append(vectors[pick])
    labels = [0] * len(vectors)
    for _ in range(rounds):
        changed = False
        for i, v in enumerate(vectors):
            best = min(range(k), key=lambda c: sum((a - b) ** 2 for a, b in zip(v, centroids[c])))
            if best != labels[i]:
                labels[i], changed = best, True
        for c in range(k):
            members = [v for v, l in zip(vectors, labels) if l == c]
            if members:
                centroids[c] = [statistics.fmean(col) for col in zip(*members)]
        if not changed:
            break
    return labels, centroids


def _segments(rows, k=4):
    """Company segments from size and spend intensity (standardised k-means), with readable names."""

    feats = [(math.log10(r["employees"]), r["spend"] / r["employees"]) for r in rows]
    cols = list(zip(*feats))
    means = [statistics.fmean(c) for c in cols]
    sds = [statistics.pstdev(c) or 1 for c in cols]
    vectors = [[(v - m) / s for v, m, s in zip(f, means, sds)] for f in feats]
    labels, centroids = _kmeans(vectors, k)

    order = sorted(range(k), key=lambda c: -centroids[c][0])  # largest companies first
    segments, names = [], set()
    for rank, c in enumerate(order):
        members = [r for r, l in zip(rows, labels) if l == c]
        if not members:
            continue
        size_z, intensity_z = centroids[c]
        size = "Enterprise" if size_z > 0.6 else "Mid-market" if size_z > -0.4 else "Small business"
        intensity = "high-intensity" if intensity_z > 0.35 else "lean" if intensity_z < -0.35 else "balanced"
        name = f"{size}, {intensity}"
        if name in names:
            name += f" ({rank + 1})"
        names.add(name)
        industries = defaultdict(int)
        for r in members:
            industries[r["industry"]] += 1
        spend = sum(r["spend"] for r in members)
        segments.append({
            "id": c,
            "name": name,
            "companies": len(members),
            "spend": round(spend, 2),
            "avg_spend": round(spend / len(members), 2),
            "avg_employees": round(statistics.fmean(r["employees"] for r in members)),
            "per_employee": round(spend / sum(r["employees"] for r in members), 2),
            "top_industry": max(industries, key=industries.get),
            "size_z": round(size_z, 3),
            "intensity_z": round(intensity_z, 3),
        })
    by_id = {s["id"]: s["name"] for s in segments}
    return segments, [by_id[l] for l in labels]


def _eta_squared(groups_of, values):
    """Share of the variance in ``values`` explained by the grouping (0-1)."""

    mean = statistics.fmean(values)
    total = sum((v - mean) ** 2 for v in values) or 1
    groups = defaultdict(list)
    for g, v in zip(groups_of, values):
        groups[g].append(v)
    between = sum(len(vs) * (statistics.fmean(vs) - mean) ** 2 for vs in groups.values())
    return between / total


def _drivers(rows):
    """What explains total spend and spend per employee (variance explained per factor)."""

    dims = {"Company size": None, "Industry": "industry", "Country": "country", "HR tool": "hr_technology",
            "Tech category": "technology_category", "Deployment": "deployment_type"}
    targets = {"spend": [math.log10(max(r["spend"], 1)) for r in rows],
               "intensity": [r["spend"] / r["employees"] for r in rows]}
    sizes = [math.log10(r["employees"]) for r in rows]
    out = {}
    for target, values in targets.items():
        scores = []
        for label, field in dims.items():
            score = _pearson(sizes, values) ** 2 if field is None else _eta_squared([r[field] for r in rows], values)
            scores.append({"factor": label, "score": round(score, 4)})
        out[target] = sorted(scores, key=lambda s: -s["score"])
    return out


def _streams():
    """Monthly revenue per product category (sales joined to products)."""

    schema = get_schema()
    if "sales_cleaned" not in schema or "products" not in schema:
        return None
    # Join in Python: products is small and an unindexed $lookup is slow.
    category_of = {p["product_id"]: p.get("category") for p in
                   db.products.find({}, {"_id": 0, "product_id": 1, "category": 1}, max_time_ms=MAX_TIME_MS).limit(5000)}
    rows = db.sales_cleaned.aggregate([
        {"$group": {"_id": {"year": "$year", "month": "$month", "product": "$product_id"}, "value": {"$sum": "$Revenue"}}},
    ], maxTimeMS=MAX_TIME_MS)
    cell = defaultdict(float)
    for r in rows:
        key = r["_id"]
        category = category_of.get(key.get("product"))
        if key.get("year") and key.get("month") and category:
            cell[(key["year"], key["month"], category)] += float(r["value"] or 0)
    months = sorted({(y, m) for y, m, _ in cell})
    categories = sorted({c for _, _, c in cell})
    if len(months) < 3 or len(categories) < 2:
        return None
    return {
        "categories": categories,
        "months": [{"label": f"{y}-{m:02d}", **{c: round(float(cell.get((y, m, c), 0)), 2) for c in categories}}
                   for y, m in months],
    }


def _briefing(rows, segments, drivers, pareto, revenue, streams):
    """A short plain-language executive summary built only from computed numbers."""

    total = sum(r["spend"] for r in rows)
    country = defaultdict(float)
    for r in rows:
        country[r["country"]] += r["spend"]
    lead = max(country, key=country.get)
    biggest = max(segments, key=lambda s: s["spend"])
    intensity = next(d for d in drivers["intensity"] if d["factor"] != "Company size")
    parts = [
        f"{len(rows)} companies spend {_fmt_money(total)} a year on HR technology; "
        f"{lead} alone accounts for {country[lead] / total:.0%}.",
        f"Spend is concentrated: {pareto['share_for_80']:.0%} of companies make up 80% of it.",
        f"{drivers['spend'][0]['factor']} explains {drivers['spend'][0]['score']:.0%} of the differences in spend. "
        + (f"Per employee, the {intensity['factor'].lower()} matters most ({intensity['score']:.0%} of the variation)."
           if intensity["score"] >= 0.1 else
           f"Spend per employee is spread evenly: no factor explains more than {intensity['score']:.0%} of it, "
           f"so pricing is not driven by industry, market or tool."),
        f"Clustering finds {len(segments)} segments; \"{biggest['name']}\" holds "
        f"{biggest['spend'] / total:.0%} of all spend across {biggest['companies']} companies.",
    ]
    if revenue:
        parts.append(f"Store revenue totals {_fmt_money(sum(p['value'] for p in revenue['series']))} over "
                     f"{len(revenue['series'])} months and is projected at "
                     f"{_fmt_money(revenue['forecast'][0]['value'])} next month.")
    if streams:
        sums = {c: sum(m[c] for m in streams["months"]) for c in streams["categories"]}
        top = max(sums, key=sums.get)
        parts.append(f"{top} is the strongest product category ({sums[top] / sum(sums.values()):.0%} of revenue).")
    return " ".join(parts)


_LAB_CACHE = {"at": 0.0, "value": None}
LAB_CACHE_SECONDS = 60


def lab():
    """The Analytics lab payload, cached briefly (it reads whole collections)."""

    import time

    if _LAB_CACHE["value"] is not None and time.monotonic() - _LAB_CACHE["at"] < LAB_CACHE_SECONDS:
        return _LAB_CACHE["value"]
    value = _build_lab()
    _LAB_CACHE.update(at=time.monotonic(), value=value)
    return value


def _build_lab():
    rows = _companies()
    if not rows:
        return {"kpis": [], "insights": []}
    flow, network, heatmap = _flow(rows), _network(rows), _heatmap(rows)
    scatter, pareto = _scatter(rows), _pareto(rows)
    segments, assignment = _segments(rows)
    for point, name in zip(scatter["points"], assignment):
        point["segment"] = name
    drivers, streams = _drivers(rows), _streams()
    outliers = _outliers(rows, scatter["fit"])
    efficiency, revenue = _efficiency(rows), _revenue()
    total = sum(r["spend"] for r in rows)
    employees = sum(r["employees"] for r in rows)
    kpis = [
        {"id": "spend", "label": "HR tech spend", "value": total, "format": "currency",
         "hint": f"{len(rows)} companies"},
        {"id": "per_head", "label": "Spend per employee", "value": total / employees, "format": "currency",
         "hint": f"{employees:,.0f} employees covered"},
        {"id": "markets", "label": "Markets", "value": len({r["country"] for r in rows}), "format": "number",
         "hint": f"{len({r['industry'] for r in rows})} industries"},
        {"id": "tools", "label": "HR tools in use", "value": len({r["hr_technology"] for r in rows}),
         "format": "number", "hint": f"{len(network['links'])} industry-tool links"},
        {"id": "gini", "label": "Spend inequality", "value": pareto["gini"], "format": "number",
         "hint": "Gini coefficient, 0 = even"},
    ]
    if revenue:
        kpis.append({"id": "revenue", "label": "Store revenue", "value": sum(p["value"] for p in revenue["series"]),
                     "format": "currency", "hint": f"{len(revenue['series'])} months",
                     "spark": [p["value"] for p in revenue["series"]]})
    return {
        "kpis": kpis,
        "flow": flow,
        "network": network,
        "chord": _chord(rows),
        "heatmap": heatmap,
        "scatter": scatter,
        "pareto": pareto,
        "outliers": outliers,
        "efficiency": efficiency,
        "revenue": revenue,
        "segments": segments,
        "drivers": drivers,
        "streams": streams,
        "briefing": _briefing(rows, segments, drivers, pareto, revenue, streams),
        "insights": _insights(rows, flow, network, heatmap, scatter, pareto, outliers, efficiency, revenue),
    }


# ---------------------------------------------------------------- chat answers

_MONEY = re.compile(r"(usd|revenue|spend|price|amount|cost|salary|sales)", re.IGNORECASE)
_NOT_CATEGORY = re.compile(r"(^_?id$|_id$|name|email|phone|address|date|time|url|description)", re.IGNORECASE)
_PREFERRED_METRIC = re.compile(r"(spend|revenue|usd|amount|price|sales|cost)", re.IGNORECASE)
_AVERAGED = re.compile(r"avg|average|mean|rate|ratio|pct|percent", re.IGNORECASE)
_MONTH = re.compile(r"^(\d{4})-(\d{2})$")


def _format_of(name):
    return "currency" if name and _MONEY.search(name) else "number"


def _numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _short(value):
    if abs(value) >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if abs(value) >= 10_000:
        return f"{value / 1_000:.1f}K"
    return f"{value:,.0f}" if float(value).is_integer() else f"{value:,.2f}"


def _words(name):
    return _pretty(name).lower().replace("(usd)", "(USD)")


def _group_spec(query):
    """(group keys, accumulator, value field) of the first $group stage, or Nones."""

    for stage in query.get("pipeline") or []:
        group = stage.get("$group") if isinstance(stage, dict) else None
        if not isinstance(group, dict):
            continue
        ident = group.get("_id")
        keys = [ident[1:]] if isinstance(ident, str) and ident.startswith("$") else \
            [k for k in ident] if isinstance(ident, dict) else []
        for name, acc in group.items():
            if name != "_id" and isinstance(acc, dict) and acc:
                op, source = next(iter(acc.items()))
                field = source[1:] if isinstance(source, str) and source.startswith("$") else None
                return keys, op.lstrip("$"), field
        return keys, None, None
    return [], None, None


def _agg_rows(collection, pipeline):
    return list(db[collection].aggregate(pipeline, maxTimeMS=MAX_TIME_MS))


def _projection(labels, values, steps=3):
    """3-point moving average and a linear projection with an 80% band."""

    moving = [round(statistics.fmean(values[max(0, i - 2): i + 1]), 2) for i in range(len(values))]
    xs = list(range(len(values)))
    slope, intercept = _fit(xs, values)
    sigma = statistics.pstdev([v - (slope * x + intercept) for x, v in zip(xs, values)])
    match = _MONTH.match(labels[-1])
    year, month = (int(match.group(1)), int(match.group(2))) if match else (0, 0)
    forecast = []
    for step in range(1, steps + 1):
        if match:
            month += 1
            if month > 12:
                year, month = year + 1, 1
            label = f"{year}-{month:02d}"
        else:
            label = f"+{step}"
        estimate = slope * (len(values) - 1 + step) + intercept
        forecast.append({"label": label, "value": round(estimate, 2),
                         "low": round(estimate - 1.28 * sigma, 2), "high": round(estimate + 1.28 * sigma, 2)})
    return moving, forecast, slope


def _share_insight(field, rows, total):
    top = max(rows, key=lambda r: r["value"])
    return {"kind": "leader", "title": f"{top['label']} leads by {_words(field)}",
            "value": f"{top['value'] / total:.0%}" if total else "",
            "detail": f"{_short(top['value'])} of {_short(total)}"}


def _breakdown_fields(collection, filters, skip=()):
    """Low-cardinality text fields worth splitting the matched documents by."""

    fields = []
    for field, info in get_schema().get(collection, {}).items():
        if info.get("type") != "str" or field in skip or _NOT_CATEGORY.search(field):
            continue
        groups = _agg_rows(collection, [{"$match": filters}, {"$group": {"_id": f"${field}", "n": {"$sum": 1}}},
                                        {"$sort": {"n": -1}}, {"$limit": 16}])
        rows = [{"label": str(g["_id"]), "value": g["n"]} for g in groups if g["_id"] is not None]
        if 2 <= len(rows) <= 15:
            fields.append((field, rows))
        if len(fields) == 3:
            break
    return fields


def _metric_field(collection):
    numeric = [f for f, info in get_schema().get(collection, {}).items()
               if info.get("type") in {"int", "float"} and not _NOT_CATEGORY.search(f) and f not in {"year", "month"}]
    preferred = [f for f in numeric if _PREFERRED_METRIC.search(f)]
    return (preferred or numeric or [None])[0]


def _count_analysis(collection, filters, matched):
    total = db[collection].estimated_document_count()
    stats = [{"label": "Matching records", "value": matched, "format": "number", "hint": f"of {total:,} in {collection}"}]
    if filters and total:
        stats.append({"label": "Share of all records", "value": matched / total, "format": "percent",
                      "hint": "of the whole collection"})
    insights = []
    if filters and total:
        insights.append({"kind": "concentration", "title": f"{matched:,} of {total:,} records match",
                         "value": f"{matched / total:.1%}", "detail": f"share of {collection}"})
    metric = _metric_field(collection)
    if metric and matched:
        part = _agg_rows(collection, [{"$match": filters}, {"$group": {
            "_id": None, "sum": {"$sum": f"${metric}"}, "avg": {"$avg": f"${metric}"}}}])
        overall = _agg_rows(collection, [{"$group": {"_id": None, "avg": {"$avg": f"${metric}"}}}])
        if part and part[0]["avg"] is not None:
            fmt = _format_of(metric)
            base = overall[0]["avg"] if overall else None
            stats.append({"label": f"Total {_words(metric)}", "value": part[0]["sum"], "format": fmt,
                          "hint": "across the matching records"})
            stats.append({"label": f"Average {_words(metric)}", "value": part[0]["avg"], "format": fmt,
                          "hint": f"vs {_short(base)} overall" if base else ""})
            if base and filters:
                diff = part[0]["avg"] / base - 1
                direction = "above" if diff >= 0 else "below"
                insights.append({"kind": "jump" if diff >= 0 else "drop",
                                 "title": f"Average {_words(metric)} is {abs(diff):.0%} {direction} the overall average",
                                 "value": f"{diff:+.0%}", "detail": f"{_short(part[0]['avg'])} vs {_short(base)}"})
    charts = []
    if filters and total and matched < total:
        charts.append({"kind": "donut", "title": "Share of the collection", "format": "number",
                       "rows": [{"label": "Matching", "value": matched}, {"label": "Everything else", "value": total - matched}]})
    skip = {k for k, v in filters.items() if not isinstance(v, dict)}
    for i, (field, rows) in enumerate(_breakdown_fields(collection, filters, skip) if matched else []):
        charts.append({"kind": "donut" if i == 0 and len(rows) <= 6 else "bars",
                       "title": f"By {_words(field)}", "format": "number", "rows": rows})
        insights.append(_share_insight(field, rows, matched))
    return {"title": f"{matched:,} matching records", "stats": stats, "charts": charts, "insights": insights}


def _distinct_analysis(collection, filters, field, values):
    groups = _agg_rows(collection, [{"$match": filters}, {"$group": {"_id": f"${field}", "n": {"$sum": 1}}},
                                    {"$sort": {"n": -1}}, {"$limit": 30}])
    bars = [{"label": str(g["_id"]), "value": g["n"]} for g in groups if g["_id"] is not None]
    if len(bars) < 2:
        return None
    total = sum(b["value"] for b in bars)
    return {
        "title": f"{len(values)} distinct {_words(field)} values",
        "stats": [{"label": "Distinct values", "value": len(values), "format": "number", "hint": _words(field)},
                  {"label": "Records covered", "value": total, "format": "number", "hint": collection}],
        "charts": [{"kind": "donut" if len(bars) <= 6 else "bars", "title": f"Records per {_words(field)}",
                    "format": "number", "rows": bars}],
        "insights": [_share_insight(field, bars, total)],
    }


_OP_WORD = {"sum": "Total", "avg": "Average", "max": "Highest", "min": "Lowest", "count": "Count"}


def _grouped_analysis(rows, query):
    pairs, metric, is_time = label_value_rows(rows)
    if len(pairs) < 2:
        return None
    keys, op, field = _group_spec(query)
    # Name the measure after what was aggregated ("Total annual hr tech spend (USD)"), not the alias.
    if field and op in _OP_WORD:
        label = f"{_OP_WORD[op]} {_words(field)}"
    elif op == "sum" or (op and not field):
        label = "Records" if op in {"sum", "count"} else _pretty(metric)
    else:
        label = _pretty(metric)
    fmt = _format_of(field or metric) if op not in {"count"} and label != "Records" else "number"
    if len(keys) == 1 and not is_time:
        label = f"{label} by {_words(keys[0])}"
    values = [v for _, v in pairs]
    total = sum(values)
    averaged = op in {"avg", "max", "min"} or bool(_AVERAGED.search(metric or ""))
    charts = []
    stats = [{"label": "Groups", "value": len(pairs), "format": "number", "hint": label.lower()}]

    keys = rows[0].get("_id")
    if isinstance(keys, dict) and len(keys) == 2 and not is_time:
        a, b = list(keys)
        cells = [{"row": str(r["_id"].get(a)), "col": str(r["_id"].get(b)), "value": round(float(v), 2)}
                 for r, (_, v) in zip(rows, pairs) if isinstance(r.get("_id"), dict)]
        charts.append({"kind": "heatmap", "title": f"{_pretty(a)} × {_pretty(b)}", "format": fmt,
                       "rows": sorted({c["row"] for c in cells}), "cols": sorted({c["col"] for c in cells}),
                       "cells": cells})

    if is_time:
        ordered = sorted(pairs)
        labels, series = [l for l, _ in ordered], [v for _, v in ordered]
        if len(series) >= 4:
            moving, forecast, slope = _projection(labels, series)
        else:
            moving, forecast, slope = series, [], 0
        charts.insert(0, {"kind": "trend", "title": f"{label} over time", "format": fmt, "forecast": forecast,
                          "rows": [{"label": l, "value": v, "avg": m} for l, v, m in zip(labels, series, moving)]})
        stats.append({"label": "Average" if averaged else "Total",
                      "value": statistics.fmean(series) if averaged else total,
                      "format": fmt, "hint": f"{labels[0]} → {labels[-1]}"})
        if series[0]:
            stats.append({"label": "Change", "value": (series[-1] - series[0]) / abs(series[0]),
                          "format": "percent", "hint": "first to last period"})
        if forecast:
            stats.append({"label": "Next period (forecast)", "value": forecast[0]["value"], "format": fmt,
                          "hint": f"trend {slope:+,.0f} per period"})
        insights = _time_insights(pairs, label)
    else:
        ranked = sorted(pairs, key=lambda p: p[1], reverse=True)
        bar_rows = [{"label": l, "value": round(float(v), 2)} for l, v in ranked]
        if not charts:
            charts.append({"kind": "bars", "title": label, "format": fmt, "rows": bar_rows[:15]})
        if not averaged and len(pairs) <= 6 and all(v >= 0 for v in values):
            charts.append({"kind": "donut", "title": "Share of total", "format": fmt, "rows": bar_rows})
        if not averaged and len(pairs) >= 5 and total > 0:
            charts.append({"kind": "pareto", "title": "How concentrated it is", **_pareto([{"spend": v} for v in values])})
        if not averaged:
            stats.append({"label": "Total", "value": total, "format": fmt, "hint": label.lower()})
        stats.append({"label": "Top group", "value": ranked[0][1], "format": fmt, "hint": ranked[0][0]})
        if ranked[-1][1]:
            stats.append({"label": "Highest ÷ lowest", "value": ranked[0][1] / ranked[-1][1], "format": "multiple",
                          "hint": f"{ranked[0][0]} vs {ranked[-1][0]}"})
        insights = _category_insights(pairs, label)
        if averaged:
            # Shares and concentration of averages are not meaningful.
            insights = [i for i in insights if i["kind"] not in {"concentration", "skew"}]
    return {"title": label, "stats": stats[:4], "charts": charts, "insights": insights}


def _document_analysis(collection, rows):
    docs = [r for r in rows if isinstance(r, dict)]
    if not docs:
        return None
    keys = [k for k in docs[0] if k != "_id"]
    numeric = [k for k in keys if all(_numeric(d.get(k)) for d in docs)
               and not _NOT_CATEGORY.search(k) and k not in {"year", "month"}]
    numeric.sort(key=lambda k: not _PREFERRED_METRIC.search(k))
    text = [k for k in keys if all(isinstance(d.get(k), str) for d in docs)]
    name_key = next((k for k in text if re.search(r"name|title", k, re.IGNORECASE)), None)
    source = collection or "the result"
    stats = [{"label": "Records", "value": len(docs), "format": "number", "hint": f"from {source}"}]
    charts, insights = [], []

    metric = numeric[0] if numeric else None
    if len(docs) == 1:
        stats += [{"label": _pretty(f), "value": float(docs[0][f]), "format": _format_of(f), "hint": "this record"}
                  for f in numeric[:3]]
    elif metric:
        values = [float(d[metric]) for d in docs]
        fmt = _format_of(metric)
        stats.append({"label": f"Total {_words(metric)}", "value": sum(values), "format": fmt,
                      "hint": f"{len(docs)} records"})
        stats.append({"label": f"Average {_words(metric)}", "value": statistics.fmean(values), "format": fmt,
                      "hint": f"median {_short(statistics.median(values))}"})
        if name_key and len(docs) >= 2:
            ranked = sorted(docs, key=lambda d: d[metric], reverse=True)
            charts.append({"kind": "bars", "title": f"{_pretty(metric)} by {_words(name_key)}", "format": fmt,
                           "rows": [{"label": str(d[name_key]), "value": float(d[metric])} for d in ranked[:12]]})
            if sum(values):
                insights.append({"kind": "leader", "title": f"{ranked[0][name_key]} is the largest",
                                 "value": f"{ranked[0][metric] / sum(values):.0%}",
                                 "detail": f"of total {_words(metric)} in this answer"})

    # A handful of records: put each number next to the collection average.
    if collection and len(docs) <= 3 and numeric:
        fields = numeric[:4]
        averages = _agg_rows(collection, [{"$group": {"_id": None, **{f: {"$avg": f"${f}"} for f in fields}}}])
        for d in docs if averages else []:
            compare = [{"label": _pretty(f), "value": float(d[f]), "baseline": round(float(averages[0][f]), 2),
                        "format": _format_of(f)} for f in fields if averages[0].get(f)]
            if not compare:
                continue
            who = d.get(name_key, "This record") if name_key else "This record"
            charts.append({"kind": "compare", "title": f"{who} vs the average", "rows": compare})
            top = max(compare, key=lambda r: abs(math.log(max(r["value"], 1e-9) / r["baseline"])))
            ratio = top["value"] / top["baseline"]
            gap = f"{ratio:.1f}× the average" if ratio >= 1 else f"{1 - ratio:.0%} below the average"
            insights.append({"kind": "jump" if ratio >= 1 else "drop",
                             "title": f"{who}: {top['label'].lower()} is {gap}",
                             "value": f"{ratio:.1f}×" if ratio >= 1 else f"−{1 - ratio:.0%}",
                             "detail": f"{_short(top['value'])} vs {_short(top['baseline'])} on average"})

    for field in [k for k in text if k != name_key and not _NOT_CATEGORY.search(k)]:
        if len(docs) < 4 or len(charts) >= 4:
            break
        sums = defaultdict(float)
        for d in docs:
            sums[d[field]] += float(d[metric]) if metric else 1
        if 2 <= len(sums) <= 15:
            parts = sorted(({"label": k, "value": round(v, 2)} for k, v in sums.items()), key=lambda r: -r["value"])
            charts.append({"kind": "donut" if len(parts) <= 6 else "bars",
                           "title": f"{_pretty(metric) if metric else 'Records'} by {_words(field)}",
                           "format": _format_of(metric) if metric else "number", "rows": parts})
            insights.append(_share_insight(field, parts, sum(r["value"] for r in parts)))

    if len(numeric) >= 2 and len(docs) >= 6:
        x_key, y_key = numeric[1], numeric[0]
        xs = [float(d[x_key]) for d in docs]
        ys = [float(d[y_key]) for d in docs]
        use_log = min(xs) > 0 and min(ys) > 0 and max(xs) / min(xs) > 50
        fx = [math.log10(v) for v in xs] if use_log else xs
        fy = [math.log10(v) for v in ys] if use_log else ys
        r = _pearson(fx, fy)
        slope, intercept = _fit(fx, fy)
        charts.append({"kind": "scatter", "title": f"{_pretty(y_key)} vs {_pretty(x_key)}",
                       "x_label": _pretty(x_key), "y_label": _pretty(y_key),
                       "x_format": _format_of(x_key), "y_format": _format_of(y_key), "log": use_log,
                       "r": round(r, 3), "slope": slope, "intercept": intercept,
                       "points": [{"label": str(d.get(name_key, "")) if name_key else "", "x": x, "y": y}
                                  for d, x, y in zip(docs, xs, ys)][:400]})
        strength = "Strong" if abs(r) >= 0.7 else "Moderate" if abs(r) >= 0.4 else "Weak"
        insights.append({"kind": "average", "title": f"{strength} link between {_words(x_key)} and {_words(y_key)}",
                         "value": f"r {r:.2f}",
                         "detail": f"{'higher' if r >= 0 else 'lower'} {_words(y_key)} goes with higher {_words(x_key)}"})
    if not charts:
        return None
    plural = "s" if len(docs) != 1 else ""
    return {"title": f"{len(docs)} record{plural} from {source}", "stats": stats[:4],
            "charts": charts[:4], "insights": insights[:4]}


def answer_analysis(query, rows):
    """``visual_analysis`` tool result for any database answer, or None.

    Grouped results get trend + forecast, ranking, share, heatmap and
    concentration views; counts get their share of the collection and a
    breakdown of the matching records; lists get distributions, a ranking,
    comparisons with the collection average and correlations. Every number
    comes from MongoDB through the already-validated query.
    """

    if not rows or not isinstance(query, dict):
        return None
    schema = get_schema()
    collection = query.get("collection") if query.get("collection") in schema else None
    filters = query.get("filters") if isinstance(query.get("filters"), dict) else {}
    operation = query.get("operation")

    if operation == "count":
        if not collection or not _numeric(rows[0].get("count")):
            return None
        result = _count_analysis(collection, filters, rows[0]["count"])
    elif operation == "distinct":
        field = query.get("field")
        if not collection or field not in schema[collection]:
            return None
        result = _distinct_analysis(collection, filters, field, rows)
    elif all(isinstance(r, dict) and "_id" in r for r in rows) and label_value_rows(rows)[0]:
        result = _grouped_analysis(rows, query)
    else:
        result = _document_analysis(collection, rows)

    if not result or not (result["charts"] or result["insights"]):
        return None
    return {**result, "operation": operation, "collection": collection}
