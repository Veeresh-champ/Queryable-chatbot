"""Field roles and account records for any dataset (no LLM, no guessing).

Uploaded sheets and sample collections name things differently
("number_of_agents_est_num", "employee_count", "members_num"). This module
reads a collection's field names and values and assigns each field a role the
dashboards and the opportunity engine understand:

    name       company / account name            country    ISO-recognisable country
    geography  service area / support regions    industry   industry, segment, products, business model
    size       headcount, agents, members, clients, locations, branches, ATMs
    finance    revenue, assets, deposits, equity, net income, spend
    growth     growth rate (numeric)             capability yes/no flags (online quote, delivery, ...)
    rating     review score                      reviews    review volume
    payment    payment types text                deployment cloud / on-prem
    date       dates; ``contract_date`` when the name says expiry / renewal / contract end

``accounts(collection)`` returns one record per company (name + country),
merging repeated rows, so each account is counted once. Values that are not
in the data stay ``None``; nothing is filled in.
"""

import re

from backend.db import db
from backend.geo import lookup

SCAN_LIMIT = 5000

_NAME = re.compile(r"((company|account|organi[sz]ation|business|customer|firm|employer)_?name|^name$|^company$)", re.I)
_COUNTRY = re.compile(r"(^country$|_country$|^country_)", re.I)
_GEOGRAPHY = re.compile(r"(geograph|coverage|service_area|support_regions|regions?$|markets?$|footprint|operating_)", re.I)
_INDUSTRY = re.compile(r"(industry|segment|sector|vertical|business_model|products?_type|service_category|"
                       r"primary_.*products|^category$|technology_category)", re.I)
_SIZE = re.compile(r"(employee|staff|headcount|agents|members|clients|customers|locations|branch|atms|stores|"
                   r"offices|franchise|outlets|sites|seats)", re.I)
_FINANCE = re.compile(r"(revenue|sales|turnover|assets|deposits|equity|income|spend|profit|arr$|mrr$|claims)", re.I)
_GROWTH = re.compile(r"(growth|cagr|yoy|increase)", re.I)
_RATING = re.compile(r"rating|score|stars", re.I)
_REVIEWS = re.compile(r"reviews?", re.I)
_PAYMENT = re.compile(r"payment", re.I)
_DEPLOY = re.compile(r"deployment|hosting", re.I)
_CONTRACT = re.compile(r"(expir|renew|contract|end_date|valid_until|term_end|maturity)", re.I)
_DATE_VALUE = re.compile(r"^\d{4}-\d{2}-\d{2}")
_SKIP = re.compile(r"(^_id$|^id$|_id$|rssd|fdic|ncua|charter|certificate|phone|zip|postal|email)", re.I)

NUMERIC = (int, float)


def _is_number(value):
    return isinstance(value, NUMERIC) and not isinstance(value, bool)


def pretty(field):
    text = re.sub(r"_(num|flag)$", "", field or "")
    text = re.sub(r"_(yes_no|est|approx|estimated|usd)$", "", text)
    text = re.sub(r"_(yes_no|est|approx|estimated)$", "", text)
    text = text.replace("_", " ").strip()
    return text[:1].upper() + text[1:]


def field_roles(collection, docs=None):
    """{role: [field, ...]} for one collection, best field first."""

    docs = docs if docs is not None else list(db[collection].find({}, {"_id": 0}).limit(SCAN_LIMIT))
    values = {}
    for doc in docs:
        for field, value in doc.items():
            if value is None or value == "":
                continue
            values.setdefault(field, []).append(value)

    roles = {key: [] for key in ("name", "country", "geography", "industry", "size", "finance", "growth",
                                 "capability", "rating", "reviews", "payment", "deployment", "date",
                                 "contract_date")}
    fields = list(values)
    numeric_twins = {f[:-4] for f in fields if f.endswith("_num")}
    flag_twins = {f[:-5] for f in fields if f.endswith("_flag")}

    for field in fields:
        sample = values[field]
        if _SKIP.search(field) or field in numeric_twins or field in flag_twins:
            continue
        numbers = all(_is_number(v) for v in sample)
        bools = all(isinstance(v, bool) for v in sample)
        texts = all(isinstance(v, str) for v in sample)
        base = re.sub(r"_(num|flag)$", "", field)

        if texts and _NAME.search(field):
            roles["name"].append(field)
        elif texts and _COUNTRY.search(field):
            roles["country"].append(field)
        elif texts and sum(1 for v in sample[:200] if lookup(v)) >= 0.8 * min(len(sample), 200) and \
                re.search(r"country|nation|location|hq", field, re.I):
            roles["country"].append(field)
        elif bools:
            roles["capability"].append(field)
        elif texts and all(_DATE_VALUE.match(v) for v in sample[:200]):
            (roles["contract_date"] if _CONTRACT.search(field) else roles["date"]).append(field)
        elif numbers:
            if _RATING.search(base) and not _REVIEWS.search(base):
                roles["rating"].append(field)
            elif _REVIEWS.search(base):
                roles["reviews"].append(field)
            elif _GROWTH.search(base):
                roles["growth"].append(field)
            elif _FINANCE.search(base):
                roles["finance"].append(field)
            elif _SIZE.search(base):
                roles["size"].append(field)
        elif texts:
            if _GEOGRAPHY.search(field):
                roles["geography"].append(field)
            elif _PAYMENT.search(field):
                roles["payment"].append(field)
            elif _DEPLOY.search(field):
                roles["deployment"].append(field)
            elif _INDUSTRY.search(field):
                roles["industry"].append(field)

    # Best field first: the most filled one.
    for key, items in roles.items():
        items.sort(key=lambda f: -len(values.get(f, [])))
    return roles


def _account_key(doc, roles):
    name_field = roles["name"][0] if roles["name"] else None
    if not name_field or not isinstance(doc.get(name_field), str):
        return None
    country_field = roles["country"][0] if roles["country"] else None
    country = doc.get(country_field) if country_field else None
    return (" ".join(doc[name_field].lower().split()), str(country or "").lower())


def accounts(collection, roles=None, docs=None):
    """One record per company (name + country). Repeated rows are merged:
    the first non-empty value of each field wins, and ``rows`` counts them."""

    docs = docs if docs is not None else list(db[collection].find({}, {"_id": 0}).limit(SCAN_LIMIT))
    roles = roles or field_roles(collection, docs)
    merged = {}
    for doc in docs:
        key = _account_key(doc, roles)
        if key is None:
            continue
        record = merged.get(key)
        if record is None:
            merged[key] = {"rows": 1, **doc}
        else:
            record["rows"] += 1
            for field, value in doc.items():
                if record.get(field) in (None, "") and value not in (None, ""):
                    record[field] = value
    return list(merged.values())


def percentile_rank(values):
    """value -> share of values at or below it (0..1), for size / revenue bands."""

    ordered = sorted(v for v in values if _is_number(v))
    n = len(ordered)
    if not n:
        return lambda value: None

    def rank(value):
        if not _is_number(value):
            return None
        below = sum(1 for v in ordered if v <= value)
        return below / n

    return rank


def band(rank):
    if rank is None:
        return None
    if rank > 0.9:
        return "enterprise"
    if rank > 0.66:
        return "large"
    if rank > 0.33:
        return "mid"
    return "small"
