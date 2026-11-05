"""Use-case suggestions: "what business opportunity is in this data, and what next?"

Deterministic and evidence-first: every suggestion points at the exact
value-added field (VAF) and value that triggered it. Nothing is invented. A
use case whose field does not exist in the data is reported as
``needs_data`` with the field it would need, and an account whose value is
missing is "unknown" for that criterion, never assumed to match.

Two questions are answered:

1. **Which use cases does this data support?** (``use_cases``) For example
   international payroll (companies operating across countries) or a
   pre-renewal campaign (contracts ending in the next 180 days).
2. **Which accounts fit my customer's profile?** (``match``) A customer
   (the seller we serve) describes who they sell to by industry, location,
   size, revenue and growth; accounts are ranked by profile fit plus the
   use-case evidence, with a funnel showing where accounts drop out.

Size and revenue are compared as bands *within each dataset* (small / mid /
large / enterprise by percentile), because "agents", "members" and
"locations" are not the same unit across industries.

    GET  /api/opportunities?project=        -> use cases, evidence, profile options
    POST /api/opportunities/match           -> funnel + ranked accounts for a profile
"""

import re
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend import profiling
from backend.auth import require_user
from backend.db import business_collection_names, db, project_scope
from backend.geo import COUNTRIES, lookup

router = APIRouter(prefix="/api/opportunities", tags=["opportunities"])

_GLOBAL = re.compile(r"\b(global(ly)?|international(ly)?|worldwide|multi[- ]?country|multinational|cross[- ]border|"
                     r"emea|apac|latam|offshore)\b", re.I)
_DIGITAL_PAYMENT = re.compile(r"(mobile|wallet|upi|apple pay|google pay|paypal|pay later|bnpl|contactless|"
                              r"digital|online|netbanking|tap)", re.I)
_LOCATION_FIELD = re.compile(r"(locations|branch|atms|stores|offices|franchise|outlets|sites)", re.I)
_ON_PREM = re.compile(r"on[- ]?prem", re.I)
_GROWTH_TAG = re.compile(r"growth", re.I)

RENEWAL_WINDOW_DAYS = 180
MULTI_SITE_MIN = 50

USE_CASES = [
    {
        "id": "international_payroll",
        "title": "International payroll & EOR",
        "for": "International payroll, Employer-of-Record and global HR compliance providers",
        "description": "Companies that operate in, or serve clients across, several countries need multi-country "
                       "payroll, contractor management and local compliance.",
        "action": "Pitch a consolidated multi-country payroll pilot, opening with the regions named in the evidence.",
        "timing": "Any time; strongest ahead of annual budget planning or a new-market launch.",
        "needs": "a country field, or a geography / regions / clients text field",
    },
    {
        "id": "contract_renewal",
        "title": "Pre-renewal campaign",
        "for": "Vendors and insurers whose contracts or policies come up for renewal",
        "description": "Accounts whose contract, policy or subscription ends within the next "
                       f"{RENEWAL_WINDOW_DAYS} days are open to a competing or upgraded offer.",
        "action": "Start a 3-touch pre-renewal sequence; lead with switching support and a price lock.",
        "timing": "Begin 90 days before the end date; follow up at 60 and 30 days.",
        "needs": "a contract end / expiry / renewal date field",
    },
    {
        "id": "digital_gap",
        "title": "Digital capability gap",
        "for": "SaaS and digital-transformation vendors (quoting, apps, claims, delivery, self-service)",
        "description": "Accounts missing a capability that most of their peers in the same dataset already have.",
        "action": "Lead with a peer benchmark (\"most of your peers already offer X\") and a fast-launch package.",
        "timing": "Any time; pair with the peer-adoption figure in the evidence.",
        "needs": "yes/no capability fields (e.g. Online Quote, Mobile App, Delivery)",
    },
    {
        "id": "multi_location",
        "title": "Multi-site operations",
        "for": "Workforce management, POS, facility services and field-service software",
        "description": f"Accounts with {MULTI_SITE_MIN}+ locations, branches, stores or ATMs run distributed "
                       "operations that need central scheduling, maintenance and reporting.",
        "action": "Offer a multi-site rollout with a one-region pilot.",
        "timing": "Any time; strongest during expansion or consolidation.",
        "needs": "a locations / branches / stores / ATMs count",
    },
    {
        "id": "fast_growth",
        "title": "Fast-growth expansion",
        "for": "Recruiting, HR tech, onboarding, financing and expansion services",
        "description": "Companies flagged as fast-growth (by dataset tag or a positive growth field) are hiring and "
                       "scaling processes.",
        "action": "Pitch scale-ready hiring and onboarding; reference their segment and client base.",
        "timing": "Now: growth windows are short.",
        "needs": "a dataset tagged 'growth' or a numeric growth field",
    },
    {
        "id": "enterprise_scale",
        "title": "Enterprise accounts",
        "for": "Enterprise-tier offers and account-based marketing",
        "description": "The top 10% of each dataset by its own size or financial measure.",
        "action": "Run account-based outreach to the economic buyer with an enterprise package.",
        "timing": "Align with their fiscal year planning.",
        "needs": "a numeric size or financial field",
    },
    {
        "id": "reputation",
        "title": "Customer-experience recovery",
        "for": "Reputation management, CX, review and support-automation vendors",
        "description": "Accounts rated below 4.2 with a large review volume: many customers see the low score.",
        "action": "Share their rating against peers in the same dataset and offer a 90-day CX improvement plan.",
        "timing": "Any time.",
        "needs": "a rating field (and ideally a review count)",
    },
    {
        "id": "payments",
        "title": "Payments modernisation",
        "for": "Payment providers, wallets, BNPL and card acquirers",
        "description": "Accounts whose listed payment methods include no mobile, wallet or digital option, or that do "
                       "not accept cards.",
        "action": "Offer digital wallet / BNPL acceptance with a quick POS integration.",
        "timing": "Any time; strongest before peak trading seasons.",
        "needs": "a payment types field or a card-accepted yes/no field",
    },
    {
        "id": "cloud_migration",
        "title": "Cloud migration",
        "for": "Cloud software vendors and migration partners",
        "description": "Accounts still running on-premise deployments.",
        "action": "Offer a migration assessment with a total-cost comparison.",
        "timing": "Ahead of on-premise renewal or hardware refresh.",
        "needs": "a deployment type field",
    },
]
USE_CASE_IDS = {case["id"] for case in USE_CASES}
SIZE_BANDS = ["small", "mid", "large", "enterprise"]


# --------------------------------------------------
# Scope and dataset context
# --------------------------------------------------

def _dataset_meta(names):
    uploads = {d["name"]: d for d in db["app_datasets"].find({"name": {"$in": list(names)}}, {"_id": 0})}
    meta = {d["_id"]: d for d in db["app_catalog_meta"].find({"_id": {"$in": list(names)}})}
    owners = {}
    for project in db["app_projects"].find({"datasets": {"$in": list(names)}}, {"name": 1, "tags": 1, "datasets": 1}):
        for name in project.get("datasets") or []:
            owners[name] = project
    out = {}
    for name in names:
        upload = uploads.get(name) or {}
        info = meta.get(name) or {}
        owner = owners.get(name) or {}
        out[name] = {
            "label": upload.get("label") or info.get("label") or name.replace("_", " ").title(),
            "tags": list(dict.fromkeys((info.get("tags") or []))),
            "project": owner.get("_id"),
            "project_name": owner.get("name"),
        }
    return out


def _text(value):
    return value if isinstance(value, str) else ""


def _shown(record, field):
    """The value as written in the source: '10,000+' rather than 10000.0 for a _num twin."""

    if field.endswith("_num") and isinstance(record.get(field[:-4]), str):
        return record[field[:-4]]
    if field.endswith("_flag") and isinstance(record.get(field[:-5]), str):
        return record[field[:-5]]
    value = record.get(field)
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, float) and value.is_integer():
        return f"{int(value):,}"
    if isinstance(value, (int, float)):
        return f"{value:,}"
    return value


def _country_id(value):
    hit = lookup(value) if isinstance(value, str) else None
    if not hit:
        return None
    kind, key = hit
    return key if kind == "country" else None


def _country_name(value):
    code = _country_id(value)
    return COUNTRIES[code]["name"] if code else (value if isinstance(value, str) else None)


class Context:
    """Every account in scope, with roles, ranks and peer adoption per dataset."""

    def __init__(self, collections):
        self.collections = list(collections)
        self.meta = _dataset_meta(self.collections)
        self.datasets = []
        self.records = []
        presence = {}
        for name in self.collections:
            docs = list(db[name].find({}, {"_id": 0}).limit(profiling.SCAN_LIMIT))
            roles = profiling.field_roles(name, docs)
            if not roles["name"]:
                continue  # not company-level data (orders, products, employees): no accounts to suggest
            records = profiling.accounts(name, roles, docs)
            size_field = roles["size"][0] if roles["size"] else None
            finance_field = roles["finance"][0] if roles["finance"] else None
            size_rank = profiling.percentile_rank([r.get(size_field) for r in records]) if size_field else None
            finance_rank = profiling.percentile_rank([r.get(finance_field) for r in records]) if finance_field else None
            adoption = {}
            for field in roles["capability"]:
                known = [r.get(field) for r in records if isinstance(r.get(field), bool)]
                if known:
                    adoption[field] = sum(known) / len(known)
            info = {
                "name": name, **self.meta[name], "roles": roles, "rows": len(docs), "accounts": len(records),
                "size_field": size_field, "finance_field": finance_field, "adoption": adoption,
                "growth_tagged": any(_GROWTH_TAG.search(t) for t in self.meta[name]["tags"])
                or bool(_GROWTH_TAG.search(self.meta[name]["label"])),
            }
            self.datasets.append(info)
            country_field = roles["country"][0] if roles["country"] else None
            for record in records:
                account = {
                    "record": record, "dataset": info,
                    "name": record.get(roles["name"][0]),
                    "country": _country_name(record.get(country_field)) if country_field else None,
                    "size_band": profiling.band(size_rank(record.get(size_field))) if size_rank else None,
                    "revenue_band": profiling.band(finance_rank(record.get(finance_field))) if finance_rank else None,
                    "size_rank": size_rank(record.get(size_field)) if size_rank else None,
                    "finance_rank": finance_rank(record.get(finance_field)) if finance_rank else None,
                }
                self.records.append(account)
                if account["country"] and account["name"]:
                    presence.setdefault(" ".join(account["name"].lower().split()), set()).add(account["country"])
        self.presence = presence

    def growth(self, account):
        info = account["dataset"]
        for field in info["roles"]["growth"]:
            value = account["record"].get(field)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return value > 0
        return True if info["growth_tagged"] else None


# --------------------------------------------------
# Use-case evidence: (field, label, value, why) for one account
# --------------------------------------------------

def _ev(field, value, why):
    return {"field": field, "label": profiling.pretty(field) if field else "Presence", "value": value, "why": why}


def evidence(case_id, account, ctx):
    record, info = account["record"], account["dataset"]
    roles = info["roles"]
    out = []
    if case_id == "international_payroll":
        countries = ctx.presence.get(" ".join((account["name"] or "").lower().split()), set())
        if len(countries) > 1:
            out.append(_ev(None, ", ".join(sorted(countries)), f"Listed in {len(countries)} countries in this data"))
        for field in roles["geography"] + roles["industry"] + [f for f in record if f.endswith(("_customers", "_clients"))]:
            text = _text(record.get(field))
            if text and _GLOBAL.search(text):
                out.append(_ev(field, text, "Mentions global / international operations or clients"))
        for field, value in record.items():
            if field not in roles["geography"] and field not in roles["industry"] and field not in roles["name"] \
                    and isinstance(value, str) and _GLOBAL.search(value) and len(out) < 3:
                if not any(e["field"] == field for e in out):
                    out.append(_ev(field, value, "Mentions global / international operations or clients"))
    elif case_id == "contract_renewal":
        today = date.today()
        for field in roles["contract_date"]:
            text = _text(record.get(field))
            try:
                when = datetime.fromisoformat(text[:10]).date()
            except ValueError:
                continue
            days = (when - today).days
            if 0 <= days <= RENEWAL_WINDOW_DAYS:
                out.append(_ev(field, text[:10], f"Ends in {days} days"))
    elif case_id == "digital_gap":
        for field, share in info["adoption"].items():
            if record.get(field) is False and share >= 0.5:
                out.append(_ev(field, "No", f"{share:.0%} of peers in {info['label']} have it"))
    elif case_id == "multi_location":
        for field in roles["size"]:
            value = record.get(field)
            if _LOCATION_FIELD.search(field) and isinstance(value, (int, float)) and value >= MULTI_SITE_MIN:
                out.append(_ev(field, _shown(record, field), f"{MULTI_SITE_MIN}+ sites to coordinate"))
        if account["record"].get("rows", 1) >= 3:
            out.append(_ev(None, f"{account['record']['rows']} entries",
                           "Listed several times in the same country (multiple offices or entities)"))
    elif case_id == "fast_growth":
        for field in roles["growth"]:
            value = record.get(field)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
                out.append(_ev(field, _shown(record, field), "Positive growth"))
        if not out and info["growth_tagged"]:
            out.append(_ev(None, info["label"], "In a dataset tagged as fast-growth"))
    elif case_id == "enterprise_scale":
        if account["size_rank"] is not None and account["size_rank"] > 0.9:
            out.append(_ev(info["size_field"], _shown(record, info["size_field"]),
                           f"Top 10% of {info['label']} by {profiling.pretty(info['size_field']).lower()}"))
        if account["finance_rank"] is not None and account["finance_rank"] > 0.9:
            out.append(_ev(info["finance_field"], _shown(record, info["finance_field"]),
                           f"Top 10% of {info['label']} by {profiling.pretty(info['finance_field']).lower()}"))
    elif case_id == "reputation":
        for field in roles["rating"]:
            score = record.get(field)
            if not isinstance(score, (int, float)) or score > 5:
                continue
            reviews_field = roles["reviews"][0] if roles["reviews"] else None
            reviews = record.get(reviews_field) if reviews_field else None
            if score < 4.2 and (reviews is None or reviews >= 1000):
                why = f"Rated {score:g}/5" + (f" across {_shown(record, reviews_field)} reviews" if reviews else "")
                out.append(_ev(field, _shown(record, field), why))
    elif case_id == "payments":
        for field in roles["payment"]:
            text = _text(record.get(field))
            if text and not _DIGITAL_PAYMENT.search(text):
                out.append(_ev(field, text, "No mobile, wallet or digital payment option listed"))
        for field in roles["capability"]:
            if re.search(r"card|payment", field, re.I) and record.get(field) is False:
                out.append(_ev(field, "No", "Does not accept cards"))
    elif case_id == "cloud_migration":
        for field in roles["deployment"]:
            text = _text(record.get(field))
            if _ON_PREM.search(text):
                out.append(_ev(field, text, "Still on-premise"))
    return out


def _supported(case_id, info):
    roles = info["roles"]
    return {
        "international_payroll": bool(roles["country"] or roles["geography"]),
        "contract_renewal": bool(roles["contract_date"]),
        "digital_gap": bool(info["adoption"]),
        "multi_location": any(_LOCATION_FIELD.search(f) for f in roles["size"]),
        "fast_growth": bool(roles["growth"]) or info["growth_tagged"],
        "enterprise_scale": bool(info["size_field"] or info["finance_field"]),
        "reputation": bool(roles["rating"]),
        "payments": bool(roles["payment"]) or any(re.search(r"card|payment", f, re.I) for f in roles["capability"]),
        "cloud_migration": bool(roles["deployment"]),
    }[case_id]


def _summary(account, items, ctx):
    info = account["dataset"]
    return {
        "name": account["name"],
        "country": account["country"],
        "dataset": info["name"],
        "dataset_label": info["label"],
        "size_band": account["size_band"],
        "revenue_band": account["revenue_band"],
        "growth": ctx.growth(account),
        "evidence": items[:4],
    }


# --------------------------------------------------
# 1. Which use cases does the data support?
# --------------------------------------------------

def use_cases(collections=None, top=6):
    collections = collections if collections is not None else business_collection_names()
    ctx = Context(collections)
    results = []
    for case in USE_CASES:
        supported = [info for info in ctx.datasets if _supported(case["id"], info)]
        hits = []
        for account in ctx.records:
            if account["dataset"] not in supported:
                continue
            items = evidence(case["id"], account, ctx)
            if items:
                hits.append((account, items))
        hits.sort(key=lambda pair: (-len(pair[1]), -(pair[0]["size_rank"] or 0)))
        considered = sum(info["accounts"] for info in supported)
        fields = sorted({e["label"] for _, items in hits for e in items if e["field"]})
        if not supported:
            status, missing = "needs_data", f"No dataset in scope has {case['needs']}."
        elif not hits:
            status, missing = "no_matches", "The fields exist, but no account currently meets the condition."
        else:
            status, missing = "ready", None
        results.append({
            **{k: case[k] for k in ("id", "title", "for", "description", "action", "timing", "needs")},
            "status": status,
            "missing": missing,
            "accounts": len(hits),
            "considered": considered,
            "share": round(len(hits) / considered, 3) if considered else 0,
            "datasets": sorted({account["dataset"]["label"] for account, _ in hits}),
            "by_dataset": _count_by(hits, lambda a: a["dataset"]["label"]),
            "by_country": _count_by(hits, lambda a: a["country"] or "Unknown")[:12],
            "signals": fields[:8],
            "top": [_summary(account, items, ctx) for account, items in hits[:top]],
        })
    order = {"ready": 0, "no_matches": 1, "needs_data": 2}
    results.sort(key=lambda r: (order[r["status"]], -r["accounts"]))
    return {
        "datasets": [{"name": d["name"], "label": d["label"], "rows": d["rows"], "accounts": d["accounts"],
                      "tags": d["tags"], "project": d["project_name"]} for d in ctx.datasets],
        "skipped": [name for name in collections if name not in {d["name"] for d in ctx.datasets}],
        "accounts": len(ctx.records),
        "use_cases": results,
        "profile_options": profile_options(ctx),
    }


def _count_by(hits, key):
    counts = {}
    for account, _ in hits:
        label = key(account)
        counts[label] = counts.get(label, 0) + 1
    return [{"label": k, "value": v} for k, v in sorted(counts.items(), key=lambda kv: -kv[1])]


def profile_options(ctx):
    industries = []
    for info in ctx.datasets:
        industries.append(info["label"])
        industries.extend(info["tags"])
    for account in ctx.records:
        for field in account["dataset"]["roles"]["industry"][:1]:
            value = account["record"].get(field)
            if isinstance(value, str) and len(value) <= 32:
                industries.append(value)
    counts = {}
    for item in industries:
        counts[item] = counts.get(item, 0) + 1
    countries = {}
    for account in ctx.records:
        if account["country"]:
            countries[account["country"]] = countries.get(account["country"], 0) + 1
    return {
        "industries": [k for k, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))][:40],
        "countries": [{"name": k, "accounts": v} for k, v in sorted(countries.items(), key=lambda kv: -kv[1])],
        "sizes": SIZE_BANDS,
        "revenues": SIZE_BANDS,
        "use_cases": [{"id": c["id"], "title": c["title"]} for c in USE_CASES],
    }


# --------------------------------------------------
# 2. Which accounts fit a customer's profile?
# --------------------------------------------------

class Profile(BaseModel):
    industries: list[str] = []
    countries: list[str] = []
    sizes: list[str] = []
    revenues: list[str] = []
    growth: bool | None = None


class MatchRequest(BaseModel):
    project: str | None = None
    use_case: str | None = None
    profile: Profile = Profile()
    include_unknown: bool = True
    limit: int = Field(default=50, ge=1, le=200)


def _industry_fit(account, wanted):
    if not wanted:
        return "any"
    info = account["dataset"]
    haystack = " ".join([info["label"], *info["tags"]] +
                        [_text(account["record"].get(f)) for f in info["roles"]["industry"]]).lower()
    if not haystack.strip():
        return "unknown"
    return "match" if any(w.lower() in haystack for w in wanted) else "no"


def _location_fit(account, wanted_ids):
    if not wanted_ids:
        return "any"
    if not account["country"]:
        return "unknown"
    return "match" if _country_id(account["country"]) in wanted_ids else "no"


def _band_fit(value, wanted):
    if not wanted:
        return "any"
    if value is None:
        return "unknown"
    return "match" if value in wanted else "no"


def _growth_fit(value, wanted):
    if wanted is None:
        return "any"
    if value is None:
        return "unknown"
    return "match" if value == wanted else "no"


def match(request: MatchRequest, collections=None):
    if request.use_case and request.use_case not in USE_CASE_IDS:
        raise ValueError(f"Unknown use case. Use one of: {', '.join(sorted(USE_CASE_IDS))}.")
    profile = request.profile
    bad_bands = [b for b in profile.sizes + profile.revenues if b not in SIZE_BANDS]
    if bad_bands:
        raise ValueError(f"Size and revenue bands must be among: {', '.join(SIZE_BANDS)}.")
    wanted_ids = {cid for cid in (_country_id(c) for c in profile.countries) if cid}
    unknown_countries = [c for c in profile.countries if not _country_id(c)]

    collections = collections if collections is not None else business_collection_names()
    ctx = Context(collections)
    steps = [("Accounts in scope", None), ("Industry", "industry"), ("Location", "location"),
             ("Size", "size"), ("Revenue", "revenue"), ("Growth", "growth")]
    funnel = {label: 0 for label, _ in steps}
    funnel["With use-case evidence"] = 0
    unknown_counts = {key: 0 for _, key in steps if key}
    ranked = []

    for account in ctx.records:
        fit = {
            "industry": _industry_fit(account, profile.industries),
            "location": _location_fit(account, wanted_ids),
            "size": _band_fit(account["size_band"], profile.sizes),
            "revenue": _band_fit(account["revenue_band"], profile.revenues),
            "growth": _growth_fit(ctx.growth(account), profile.growth),
        }
        alive = True
        for label, key in steps:
            if key:
                state = fit[key]
                if state == "unknown":
                    unknown_counts[key] += 1
                if state == "no" or (state == "unknown" and not request.include_unknown):
                    alive = False
            if not alive:
                break
            funnel[label] += 1
        if not alive:
            continue

        cases = [request.use_case] if request.use_case else [c["id"] for c in USE_CASES]
        found = {}
        for case_id in cases:
            if _supported(case_id, account["dataset"]):
                items = evidence(case_id, account, ctx)
                if items:
                    found[case_id] = items
        if request.use_case and not found:
            continue
        if found:
            funnel["With use-case evidence"] += 1
        criteria = [v for v in fit.values() if v != "any"]
        matched = sum(1 for v in criteria if v == "match")
        unknown = sum(1 for v in criteria if v == "unknown")
        score = (matched + 0.3 * unknown) / len(criteria) * 60 if criteria else 30
        score += min(40, 14 * sum(len(v) for v in found.values()))
        ranked.append({
            **_summary(account, [e for items in found.values() for e in items], ctx),
            "score": round(score),
            "fit": fit,
            "use_cases": list(found),
        })

    ranked.sort(key=lambda r: (-r["score"], r["name"] or ""))
    notes = []
    labels = {"industry": "industry", "location": "country", "size": "size", "revenue": "revenue / financial",
              "growth": "growth"}
    for key, n in unknown_counts.items():
        if n:
            verb = "kept and marked unknown" if request.include_unknown else "excluded"
            notes.append(f"{n} account(s) have no {labels[key]} data for this filter: {verb}, not assumed to match.")
    if unknown_countries:
        notes.append("Not recognised as countries and ignored: " + ", ".join(unknown_countries) + ".")
    if not ctx.datasets:
        notes.append("No company-level dataset in this scope (a dataset needs a company / account name field).")
    return {
        "funnel": [{"step": label, "count": funnel[label]} for label in funnel],
        "accounts": ranked[: request.limit],
        "total": len(ranked),
        "notes": notes,
        "bands": "Size and revenue bands are percentiles within each dataset: small ≤33%, mid ≤66%, "
                 "large ≤90%, enterprise = top 10%.",
    }


# --------------------------------------------------
# Chat helpers
# --------------------------------------------------

_INTENT = re.compile(r"(opportunit|use[- ]?case|who should (we|i) (target|sell|pitch|call)|what should (we|i) do next|"
                     r"next best action|campaign|upsell|cross[- ]sell|pitch|prospect|lead list|ideal customer|"
                     r"\bicp\b|renewal|payroll|whitespace|white space)", re.I)


def is_opportunity_question(text):
    return bool(_INTENT.search(text or ""))


def next_best_actions(collections, limit=3):
    """Short suggestions for the collections a chat answer just used."""

    names = [c for c in collections if c in set(business_collection_names())]
    if not names:
        return None
    result = use_cases(names, top=3)
    ready = [case for case in result["use_cases"] if case["status"] == "ready"][:limit]
    if not ready:
        return None
    return {
        "scope": [d["label"] for d in result["datasets"]],
        "accounts": result["accounts"],
        "use_cases": [{k: case[k] for k in ("id", "title", "for", "action", "timing", "accounts", "considered",
                                              "signals", "top")} for case in ready],
    }


def chat_summary(collections=None):
    """Compact, grounded facts for an opportunity question (fed to the answer model)."""

    result = use_cases(collections, top=5)
    return {
        "datasets": result["datasets"],
        "accounts": result["accounts"],
        "use_cases": [
            {
                "title": case["title"], "status": case["status"], "for": case["for"],
                "accounts": case["accounts"], "considered": case["considered"],
                "action": case["action"], "timing": case["timing"], "missing": case["missing"],
                "top_accounts": [
                    {"name": a["name"], "country": a["country"], "dataset": a["dataset_label"],
                     "evidence": [f"{e['label']}: {e['value']} ({e['why']})" for e in a["evidence"][:2]]}
                    for a in case["top"]
                ],
            }
            for case in result["use_cases"]
        ],
    }


# --------------------------------------------------
# Endpoints (scoped by the caller's permissions and the chosen project)
# --------------------------------------------------

def _scope(user, project):
    from backend.projects import allowed_collections  # local import: projects imports admin/auth

    return allowed_collections(user, project or None)


def _run(function, *args):
    try:
        return function(*args)
    except ValueError as error:
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": str(error)})


@router.get("")
def get_use_cases(project: str | None = None, user=Depends(require_user)):
    allowed = _scope(user, project)
    with project_scope(allowed):
        return _run(use_cases, sorted(set(business_collection_names())))


@router.post("/match")
def post_match(request: MatchRequest, user=Depends(require_user)):
    allowed = _scope(user, request.project)
    with project_scope(allowed):
        return _run(match, request, sorted(set(business_collection_names())))
