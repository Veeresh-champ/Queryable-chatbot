"""IBM HR Analytics (employee attrition): dashboard and Analytics lab views.

A second, fully separate dataset next to the SPAN companies / e-commerce
data. Every number is computed from the ``ibm_hr_employees`` collection
(Kaggle "IBM HR Analytics Employee Attrition & Performance", imported by
scripts/import_ibm_hr.py); there is no LLM call and nothing is mixed with
the other collections.

* ``lab()``       payload for the Analytics lab when the IBM HR dataset is picked
* ``overview()``  KPI tiles, panels and headlines for the Insights dashboard
* ``datasets()``  the datasets the dashboard and lab can switch between
"""

import statistics
import time
from collections import defaultdict

from backend.analytics import _eta_squared, _pearson
from backend.config import IBM_HR_COLLECTION, settings
from backend.db import db

COLLECTION = IBM_HR_COLLECTION
MAX_TIME_MS = settings.mongo_max_time_ms

# Ordinal codes, labelled as in the dataset's documentation.
LEVELS = {
    "Education": {1: "Below college", 2: "College", 3: "Bachelor", 4: "Master", 5: "Doctor"},
    "EnvironmentSatisfaction": {1: "Low", 2: "Medium", 3: "High", 4: "Very high"},
    "JobInvolvement": {1: "Low", 2: "Medium", 3: "High", 4: "Very high"},
    "JobSatisfaction": {1: "Low", 2: "Medium", 3: "High", 4: "Very high"},
    "RelationshipSatisfaction": {1: "Low", 2: "Medium", 3: "High", 4: "Very high"},
    "WorkLifeBalance": {1: "Bad", 2: "Good", 3: "Better", 4: "Best"},
    "PerformanceRating": {1: "Low", 2: "Good", 3: "Excellent", 4: "Outstanding"},
    "JobLevel": {i: f"Level {i}" for i in range(1, 6)},
    "StockOptionLevel": {i: f"Level {i}" for i in range(0, 4)},
}

# Breakdowns offered in the lab, in display order: field -> label.
DIMENSIONS = {
    "OverTime": "Overtime",
    "Department": "Department",
    "JobRole": "Job role",
    "JobLevel": "Job level",
    "MaritalStatus": "Marital status",
    "BusinessTravel": "Business travel",
    "StockOptionLevel": "Stock options",
    "JobSatisfaction": "Job satisfaction",
    "EnvironmentSatisfaction": "Environment",
    "WorkLifeBalance": "Work-life balance",
    "EducationField": "Education field",
    "Gender": "Gender",
}

NUMERIC = {
    "MonthlyIncome": "Monthly income",
    "Age": "Age",
    "TotalWorkingYears": "Total working years",
    "YearsAtCompany": "Years at company",
    "DistanceFromHome": "Distance from home",
    "NumCompaniesWorked": "Companies worked at",
}

FIELDS = ("EmployeeNumber", "Attrition", "YearsInCurrentRole", "YearsSinceLastPromotion",
          "PercentSalaryHike", "PerformanceRating", *DIMENSIONS, *NUMERIC)

TENURE_BUCKETS = [(0, 0, "< 1"), (1, 1, "1"), (2, 2, "2"), (3, 3, "3"), (4, 4, "4"), (5, 5, "5"),
                  (6, 7, "6–7"), (8, 10, "8–10"), (11, 15, "11–15"), (16, 20, "16–20"), (21, 99, "21+")]


def _label(field, value):
    names = LEVELS.get(field)
    if names and value in names:
        return names[value]
    if field == "BusinessTravel" and isinstance(value, str):
        return {"Travel_Rarely": "Travels rarely", "Travel_Frequently": "Travels frequently", "Non-Travel": "No travel"}.get(value, value)
    return str(value)


def _employees():
    projection = {"_id": 0, **{f: 1 for f in FIELDS}}
    rows = []
    for doc in db[COLLECTION].find({}, projection, max_time_ms=MAX_TIME_MS).limit(20000):
        if doc.get("Attrition") not in {"Yes", "No"} or not isinstance(doc.get("MonthlyIncome"), (int, float)):
            continue
        doc["left"] = 1 if doc["Attrition"] == "Yes" else 0
        rows.append(doc)
    return rows


def _rate(rows):
    return sum(r["left"] for r in rows) / len(rows) if rows else 0.0


def _money(value):
    return f"${value:,.0f}"


# ---------------------------------------------------------------- views

def _breakdowns(rows):
    """Attrition rate per value of each dimension (ordinal fields keep their order)."""

    out = {}
    for field, label in DIMENSIONS.items():
        groups = defaultdict(list)
        for r in rows:
            if r.get(field) is not None:
                groups[r[field]].append(r)
        items = [{"key": k, "label": _label(field, k), "employees": len(g), "left": sum(r["left"] for r in g),
                  "rate": round(_rate(g), 4)} for k, g in groups.items()]
        if field in LEVELS:
            items.sort(key=lambda i: i["key"])
        else:
            items.sort(key=lambda i: -i["rate"])
        out[field] = {"label": label, "ordinal": field in LEVELS,
                      "rows": [{k: v for k, v in i.items() if k != "key"} for i in items]}
    return out


def _drivers(rows):
    """Share of the variation in leaving (and in pay) that each factor explains on its own."""

    left = [r["left"] for r in rows]
    income = [r["MonthlyIncome"] for r in rows]

    def score(field, target):
        values = [r[field] for r in rows]
        if field in NUMERIC:
            return _pearson(values, target) ** 2
        return _eta_squared(values, target)

    labels = {**DIMENSIONS, **NUMERIC}
    attrition = [{"factor": labels[f], "score": round(score(f, left), 4)} for f in labels]
    pay = [{"factor": labels[f], "score": round(score(f, income), 4)} for f in labels if f != "MonthlyIncome"]
    return {"attrition": sorted(attrition, key=lambda d: -d["score"])[:6],
            "income": sorted(pay, key=lambda d: -d["score"])[:6]}


def _distributions(rows, bins=14):
    """Histogram of stayers vs leavers for each numeric field."""

    out = {}
    for field, label in NUMERIC.items():
        values = [r[field] for r in rows]
        lo, hi = min(values), max(values)
        width = max((hi - lo) / bins, 1)
        if field != "MonthlyIncome":
            width = max(1, round(width))
        count = int((hi - lo) // width) + 1
        stayed, gone = [0] * count, [0] * count
        for r in rows:
            i = min(count - 1, int((r[field] - lo) // width))
            (gone if r["left"] else stayed)[i] += 1
        median_stayed = statistics.median(r[field] for r in rows if not r["left"])
        median_left = statistics.median(r[field] for r in rows if r["left"])
        out[field] = {
            "label": label,
            "format": "currency" if field == "MonthlyIncome" else "number",
            "bins": [{"from": round(lo + i * width, 2), "to": round(lo + (i + 1) * width, 2),
                      "stayed": stayed[i], "left": gone[i]} for i in range(count)],
            "median_stayed": median_stayed,
            "median_left": median_left,
        }
    return out


def _tenure(rows):
    out = []
    for low, high, label in TENURE_BUCKETS:
        group = [r for r in rows if low <= r["YearsAtCompany"] <= high]
        if group:
            out.append({"label": label, "employees": len(group), "rate": round(_rate(group), 4)})
    return out


def _heatmaps(rows):
    pairs = {
        "satisfaction": ("JobSatisfaction", "EnvironmentSatisfaction", "Job satisfaction × environment"),
        "role_overtime": ("JobRole", "OverTime", "Job role × overtime"),
        "level_travel": ("JobLevel", "BusinessTravel", "Job level × business travel"),
    }
    out = []
    for key, (row_field, col_field, title) in pairs.items():
        cells = defaultdict(list)
        for r in rows:
            cells[(r[row_field], r[col_field])].append(r)
        row_keys = sorted({k[0] for k in cells}, key=lambda v: (v if row_field in LEVELS else -_rate(
            [r for r in rows if r[row_field] == v])))
        col_keys = sorted({k[1] for k in cells}, key=lambda v: (v if col_field in LEVELS else str(v)))
        out.append({
            "id": key,
            "title": title,
            "row_label": DIMENSIONS[row_field],
            "col_label": DIMENSIONS[col_field],
            "rows": [_label(row_field, v) for v in row_keys],
            "cols": [_label(col_field, v) for v in col_keys],
            "cells": [{"row": _label(row_field, a), "col": _label(col_field, b), "employees": len(g),
                       "rate": round(_rate(g), 4)} for (a, b), g in cells.items()],
        })
    return out


def _pay_gap(rows):
    """Median monthly income of stayers vs leavers in each job role."""

    out = []
    for role in sorted({r["JobRole"] for r in rows}):
        group = [r for r in rows if r["JobRole"] == role]
        stayed = [r["MonthlyIncome"] for r in group if not r["left"]]
        gone = [r["MonthlyIncome"] for r in group if r["left"]]
        if stayed and len(gone) >= 3:
            out.append({"role": role, "stayed": statistics.median(stayed), "left": statistics.median(gone),
                        "employees": len(group), "rate": round(_rate(group), 4)})
    return sorted(out, key=lambda p: p["left"] / p["stayed"])


def _profiles(rows, overall, min_size=25):
    """Highest- and lowest-risk employee profiles (overtime × marital status × job level)."""

    groups = defaultdict(list)
    for r in rows:
        groups[(r["OverTime"], r["MaritalStatus"], r["JobLevel"])].append(r)
    items = []
    for (overtime, marital, level), group in groups.items():
        if len(group) < min_size:
            continue
        rate = _rate(group)
        items.append({"profile": f"{'Overtime' if overtime == 'Yes' else 'No overtime'} · {marital} · Level {level}",
                      "employees": len(group), "left": sum(r["left"] for r in group), "rate": round(rate, 4),
                      "lift": round(rate / overall, 2) if overall else 0})
    items.sort(key=lambda i: -i["rate"])
    return {"high": items[:6], "low": items[-3:][::-1] if len(items) > 6 else []}


def _scatter(rows):
    return [{"id": r["EmployeeNumber"], "income": r["MonthlyIncome"], "years": r["TotalWorkingYears"],
             "age": r["Age"], "role": r["JobRole"], "overtime": r["OverTime"], "left": r["left"]} for r in rows]


def _kpis(rows):
    overall = _rate(rows)
    overtime = [r for r in rows if r["OverTime"] == "Yes"]
    incomes = [r["MonthlyIncome"] for r in rows]
    return [
        {"id": "headcount", "label": "Employees", "value": len(rows), "format": "number",
         "hint": f"{len({r['Department'] for r in rows})} departments · {len({r['JobRole'] for r in rows})} roles"},
        {"id": "attrition", "label": "Attrition rate", "value": overall, "format": "percent",
         "hint": f"{sum(r['left'] for r in rows)} employees left"},
        {"id": "income", "label": "Avg monthly income", "value": statistics.fmean(incomes), "format": "currency",
         "hint": f"median {_money(statistics.median(incomes))}"},
        {"id": "tenure", "label": "Avg years at company", "value": statistics.fmean(r["YearsAtCompany"] for r in rows),
         "format": "number", "hint": f"avg age {statistics.fmean(r['Age'] for r in rows):.0f}"},
        {"id": "overtime", "label": "Working overtime", "value": len(overtime) / len(rows), "format": "percent",
         "hint": f"{_rate(overtime):.0%} of them left"},
        {"id": "satisfaction", "label": "Job satisfaction", "value": statistics.fmean(r["JobSatisfaction"] for r in rows),
         "format": "number", "hint": "average on a 1–4 scale"},
    ]


def _insights(rows, breakdowns, drivers, distributions, tenure, pay_gap, profiles):
    overall = _rate(rows)
    out = []
    ot = {r["label"]: r for r in breakdowns["OverTime"]["rows"]}
    if "Yes" in ot and "No" in ot and ot["No"]["rate"]:
        out.append({"kind": "leader", "view": "breakdown",
                    "title": f"Overtime raises the risk {ot['Yes']['rate'] / ot['No']['rate']:.1f}×: "
                             f"{ot['Yes']['rate']:.0%} vs {ot['No']['rate']:.0%}",
                    "detail": f"{ot['Yes']['left']} of the {sum(r['left'] for r in rows)} leavers worked overtime"})
    role = max(breakdowns["JobRole"]["rows"], key=lambda r: r["rate"])
    out.append({"kind": "hotspot", "view": "breakdown",
                "title": f"{role['label']}s leave most often ({role['rate']:.0%})",
                "detail": f"{role['left']} of {role['employees']} in the role, against {overall:.0%} company-wide"})
    top = drivers["attrition"][0]
    out.append({"kind": "correlation", "view": "drivers",
                "title": f"{top['factor']} is the strongest single driver of leaving",
                "detail": f"It explains {top['score']:.1%} of the variation in attrition on its own"})
    income = distributions["MonthlyIncome"]
    out.append({"kind": "efficiency", "view": "distribution",
                "title": f"Leavers earn {1 - income['median_left'] / income['median_stayed']:.0%} less",
                "detail": f"Median {_money(income['median_left'])} a month vs {_money(income['median_stayed'])} for stayers"})
    first = tenure[0] if tenure else None
    if first:
        out.append({"kind": "forecast", "view": "tenure",
                    "title": f"{first['rate']:.0%} of first-year employees leave",
                    "detail": "Attrition falls steadily with tenure after the first two years"})
    if profiles["high"]:
        risk = profiles["high"][0]
        out.append({"kind": "outlier", "view": "profiles",
                    "title": f"{risk['profile']}: {risk['rate']:.0%} attrition",
                    "detail": f"{risk['lift']:.1f}× the company average across {risk['employees']} employees"})
    if pay_gap:
        gap = pay_gap[0]
        out.append({"kind": "concentration", "view": "pay",
                    "title": f"Biggest pay gap: {gap['role']}",
                    "detail": f"Leavers' median {_money(gap['left'])} vs {_money(gap['stayed'])} for those who stayed"})
    return out


def _briefing(rows, breakdowns, drivers, distributions, profiles):
    overall = _rate(rows)
    dept = max(breakdowns["Department"]["rows"], key=lambda r: r["rate"])
    ot = {r["label"]: r for r in breakdowns["OverTime"]["rows"]}
    income = distributions["MonthlyIncome"]
    parts = [
        f"{len(rows):,} employees, {sum(r['left'] for r in rows)} of whom left: an attrition rate of {overall:.1%}.",
        f"{dept['label']} loses the most people ({dept['rate']:.0%}).",
    ]
    if "Yes" in ot and "No" in ot:
        parts.append(f"Overtime is the clearest warning sign: {ot['Yes']['rate']:.0%} of those working overtime left, "
                     f"against {ot['No']['rate']:.0%} of the rest.")
    parts.append(f"Leavers are paid less (median {_money(income['median_left'])} vs "
                 f"{_money(income['median_stayed'])} a month) and are younger "
                 f"(median age {distributions['Age']['median_left']:.0f} vs {distributions['Age']['median_stayed']:.0f}).")
    parts.append(f"The top drivers are {', '.join(d['factor'].lower() for d in drivers['attrition'][:3])}.")
    if profiles["high"]:
        parts.append(f"Highest-risk profile: {profiles['high'][0]['profile'].lower()} "
                     f"({profiles['high'][0]['rate']:.0%}).")
    return " ".join(parts)


# ---------------------------------------------------------------- payloads

_CACHE = {"lab": (0.0, None), "overview": (0.0, None)}
CACHE_SECONDS = 60


def _cached(key, build):
    at, value = _CACHE[key]
    if value is not None and time.monotonic() - at < CACHE_SECONDS:
        return value
    value = build()
    _CACHE[key] = (time.monotonic(), value)
    return value


def clear_cache():
    for key in _CACHE:
        _CACHE[key] = (0.0, None)


def lab():
    """The Analytics lab payload for the IBM HR dataset."""

    return _cached("lab", _build_lab)


def _build_lab():
    rows = _employees()
    if not rows:
        return {"dataset": "ibm_hr", "kpis": [], "insights": []}
    overall = _rate(rows)
    breakdowns, drivers = _breakdowns(rows), _drivers(rows)
    distributions, tenure = _distributions(rows), _tenure(rows)
    pay_gap, profiles = _pay_gap(rows), _profiles(rows, overall)
    return {
        "dataset": "ibm_hr",
        "kpis": _kpis(rows),
        "overall_rate": round(overall, 4),
        "breakdowns": breakdowns,
        "drivers": drivers,
        "distributions": distributions,
        "tenure": tenure,
        "heatmaps": _heatmaps(rows),
        "pay_gap": pay_gap,
        "profiles": profiles,
        "scatter": _scatter(rows),
        "briefing": _briefing(rows, breakdowns, drivers, distributions, profiles),
        "insights": _insights(rows, breakdowns, drivers, distributions, tenure, pay_gap, profiles),
    }


def overview():
    """Insights dashboard (same shape as insights.overview) for the IBM HR dataset."""

    return _cached("overview", _build_overview)


def _build_overview():
    rows = _employees()
    if not rows:
        return {"kpis": [], "panels": [], "maps": [], "headlines": []}
    breakdowns = _breakdowns(rows)

    def rates(field):
        return [{"label": r["label"], "value": r["rate"]} for r in breakdowns[field]["rows"]]

    def heads(field, names=None):
        return [{"label": (names or {}).get(r["label"], r["label"]), "value": r["employees"]}
                for r in breakdowns[field]["rows"]]

    panels = [
        {"id": "dept_rate", "title": "Attrition rate by department", "kind": "bar", "metric": "Attrition rate",
         "format": "percent", "rows": rates("Department")},
        {"id": "dept_heads", "title": "Employees by department", "kind": "donut", "metric": "Employees",
         "format": "number", "rows": heads("Department")},
        {"id": "role_rate", "title": "Attrition rate by job role", "kind": "bar", "metric": "Attrition rate",
         "format": "percent", "rows": rates("JobRole")},
        {"id": "overtime_heads", "title": "Overtime", "kind": "donut", "metric": "Employees",
         "format": "number", "rows": heads("OverTime", {"Yes": "Overtime", "No": "No overtime"})},
        {"id": "tenure_rate", "title": "Attrition rate by years at company", "kind": "line", "metric": "Attrition rate",
         "format": "percent", "rows": [{"label": t["label"], "value": t["rate"]} for t in _tenure(rows)]},
        {"id": "travel_rate", "title": "Attrition rate by business travel", "kind": "bar", "metric": "Attrition rate",
         "format": "percent", "rows": rates("BusinessTravel")},
        {"id": "marital_heads", "title": "Employees by marital status", "kind": "donut", "metric": "Employees",
         "format": "number", "rows": heads("MaritalStatus")},
        {"id": "field_rate", "title": "Attrition rate by education field", "kind": "bar", "metric": "Attrition rate",
         "format": "percent", "rows": rates("EducationField")},
    ]
    headlines = [_panel_headline(p) for p in panels if len(p["rows"]) >= 2]
    return {"kpis": _kpis(rows), "panels": panels, "maps": [], "headlines": headlines[:8]}


def _panel_headline(panel):
    rows = sorted(panel["rows"], key=lambda r: -r["value"])
    if panel["format"] == "percent":
        if panel["kind"] == "line":
            low = rows[-1]
            peak = "the first year" if rows[0]["label"] == "< 1" else f"{rows[0]['label']} years"
            return {"kind": "trend", "title": f"Highest in {peak}", "value": f"{rows[0]['value']:.0%}",
                    "detail": f"falls to {low['value']:.0%} at {low['label']} years", "source": panel["title"]}
        return {"kind": "leader", "title": f"{rows[0]['label']} is highest", "value": f"{rows[0]['value']:.0%}",
                "detail": f"vs {rows[-1]['value']:.0%} for {rows[-1]['label']}", "source": panel["title"]}
    total = sum(r["value"] for r in rows) or 1
    return {"kind": "leader", "title": f"{rows[0]['label']} leads", "value": f"{rows[0]['value'] / total:.0%}",
            "detail": f"share of {panel['metric'].lower()}", "source": panel["title"]}


def available():
    try:
        return db[COLLECTION].estimated_document_count() > 0
    except Exception:  # noqa: BLE001 - MongoDB down: only the default dataset is offered
        return False


def datasets():
    """Datasets the Insights dashboard and Analytics lab can switch between."""

    out = [{"id": "span", "label": "SPAN companies & sales",
            "description": "HR tech spend of 500 companies plus the e-commerce sales tables."}]
    if available():
        out.append({"id": "ibm_hr", "label": "IBM HR attrition",
                    "description": "1,470 IBM employees: attrition, pay, satisfaction and tenure (Kaggle)."})
    return out
