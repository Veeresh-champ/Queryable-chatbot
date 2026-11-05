"""Projects: folders of datasets, with tags, an ON/OFF switch and access control.

A project groups several datasets (MongoDB collections), the way a Claude
project groups chats. Admins create projects, move datasets into them, tag
them, switch them on or off and decide who may use them. The backend enforces
all of it; the UI only reflects it.

Rules (see ``allowed_collections``):

* A dataset belongs to at most one project. Datasets in no project
  ("Unassigned") stay readable by every signed-in user, as before projects.
* A project that is **off** is invisible to everyone: chat, dashboards,
  insights and opportunities all skip its datasets (``backend.db`` gate).
* ``access == "members"`` limits a project to the listed usernames; admins
  always have access. ``access == "everyone"`` is open to all users.
* A chat (or dashboard call) may name one project. It then reads only that
  project's datasets, and only if the project is on and the user may use it.

    GET    /api/projects                      -> projects the user can use (admins: all + catalog detail)
    POST   /api/projects                      -> create (admin)
    PATCH  /api/projects/{id}                 -> rename, describe, tag, enable/disable, access (admin)
    DELETE /api/projects/{id}                 -> delete the folder; datasets become unassigned (admin)
    PUT    /api/projects/{id}/datasets        -> set the project's datasets (admin)
    POST   /api/projects/{id}/datasets/{name} -> move one dataset into the project (admin)
    DELETE /api/projects/{id}/datasets/{name} -> take one dataset out (admin)
    GET    /api/projects/{id}/threads         -> the caller's chats in this project
    PATCH  /api/catalog-meta/{name}           -> tags / category of any dataset (admin)
"""

import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.admin import _audit, require_admin
from backend.auth import require_user
from backend.db import business_collection_names, db, invalidate_project_cache
from backend.schema_discovery import clear_schema_cache

router = APIRouter(prefix="/api/projects", tags=["projects"])
meta_router = APIRouter(prefix="/api/catalog-meta", tags=["catalog"])

projects = db["app_projects"]
catalog_meta = db["app_catalog_meta"]

ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,47}$")
TAG_PATTERN = re.compile(r"^[\w &/+.-]{1,32}$")
MAX_TAGS = 12
CATEGORIES = ["Market intelligence", "Sales & revenue", "People & HR", "Finance", "Operations", "Other"]

# Created once, the first time the app starts with no projects, so the
# existing sample data shows up organised instead of as one flat list.
DEFAULT_PROJECTS = [
    {"_id": "span-hr-tech", "name": "SPAN HR-tech market", "category": "Market intelligence",
     "description": "500 companies with their HR technology, deployment model and annual HR-tech spend.",
     "tags": ["hr-tech", "companies", "spend"], "datasets": ["span_companies"]},
    {"_id": "ecommerce-sales", "name": "E-commerce sales", "category": "Sales & revenue",
     "description": "Kaggle e-commerce sample: customers, orders, order items, products and monthly sales.",
     "tags": ["sales", "orders", "customers"],
     "datasets": ["customers", "orders", "order_items", "products", "sales_cleaned"]},
    {"_id": "people-analytics", "name": "People analytics", "category": "People & HR",
     "description": "IBM HR attrition dataset (1,470 employees) and the small employees sample.",
     "tags": ["hr", "attrition"], "datasets": ["ibm_hr_employees", "employees"]},
]


def _bad(code, message, status=400):
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _now():
    return datetime.now(timezone.utc)


def _iso(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return value


def ensure_indexes():
    projects.create_index("datasets")
    projects.create_index("enabled")


def bootstrap_defaults():
    """Seed the default projects for whichever sample collections exist."""

    if projects.estimated_document_count():
        return 0
    existing = set(business_collection_names(include_disabled=True, scoped=False))
    created = 0
    for template in DEFAULT_PROJECTS:
        datasets = [name for name in template["datasets"] if name in existing]
        if not datasets:
            continue
        now = _now()
        projects.insert_one({**template, "datasets": datasets, "enabled": True, "access": "everyone",
                             "members": [], "created_by": "system", "created_at": now, "updated_at": now})
        created += 1
    invalidate_project_cache()
    return created


# --------------------------------------------------
# Access resolution (used by chat, dashboards and opportunities)
# --------------------------------------------------

def is_admin(user):
    return bool(user) and user.get("role") == "admin"


def can_use(user, project):
    """May ``user`` read this project's data? (ignores the ON/OFF switch)."""

    if is_admin(user):
        return True
    if project.get("access", "everyone") == "everyone":
        return True
    return user.get("username") in (project.get("members") or [])


def allowed_collections(user, project_id=None):
    """The collections this user may read, optionally limited to one project.

    Raises 404 for an unknown project or one the user may not see (no
    existence leak), and 409 when the project is switched off.
    """

    every = set(business_collection_names(scoped=False))  # already drops disabled projects
    if project_id:
        project = projects.find_one({"_id": project_id})
        if not project or not can_use(user, project):
            raise _bad("project_not_found", "That project does not exist or you do not have access to it.", 404)
        if not project.get("enabled", True):
            raise _bad("project_disabled", f"The project '{project['name']}' is switched off by an administrator.", 409)
        return every & set(project.get("datasets") or [])

    blocked = set()
    for project in projects.find({}, {"datasets": 1, "access": 1, "members": 1}):
        if not can_use(user, project):
            blocked.update(project.get("datasets") or [])
    return every - blocked


def project_of(collection):
    return projects.find_one({"datasets": collection}, {"_id": 1, "name": 1, "enabled": 1, "tags": 1})


def tags_by_collection():
    """{collection: {"tags": [...], "category": str|None, "project": id|None}}."""

    out = {}
    for doc in catalog_meta.find({}):
        out[doc["_id"]] = {"tags": doc.get("tags") or [], "category": doc.get("category")}
    for project in projects.find({}, {"datasets": 1}):
        for name in project.get("datasets") or []:
            out.setdefault(name, {"tags": [], "category": None})["project"] = project["_id"]
    return out


# --------------------------------------------------
# Serialisation
# --------------------------------------------------

def _clean_tags(tags):
    out = []
    for tag in tags or []:
        tag = " ".join(str(tag).split()).strip().lower()[:32]
        if tag and TAG_PATTERN.match(tag) and tag not in out:
            out.append(tag)
    return out[:MAX_TAGS]


def _slug(name):
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:40] or "project"
    if not slug[0].isalnum():
        slug = f"p-{slug}"
    if len(slug) < 2:
        slug = f"{slug}-project"
    candidate, n = slug, 2
    while projects.find_one({"_id": candidate}, {"_id": 1}):
        candidate = f"{slug}-{n}"
        n += 1
    return candidate


def _dataset_info(name, uploads, meta):
    upload = uploads.get(name) or {}
    info = meta.get(name) or {}
    try:
        rows = db[name].estimated_document_count()
    except Exception:  # noqa: BLE001
        rows = None
    return {
        "name": name,
        "label": upload.get("label") or info.get("label") or name.replace("_", " ").title(),
        "description": upload.get("description") or info.get("description") or "",
        "rows": rows,
        "source": "upload" if upload else "sample",
        "tags": info.get("tags") or [],
        "category": info.get("category"),
        "quality": upload.get("quality"),
        "temporary": bool(upload.get("temporary")),
        "expires_at": _iso(upload.get("expires_at")) if upload.get("temporary") else None,
    }


def _public(project, user, uploads=None, meta=None, threads=0):
    base = {
        "id": project["_id"],
        "name": project["name"],
        "description": project.get("description", ""),
        "category": project.get("category"),
        "tags": project.get("tags") or [],
        "enabled": project.get("enabled", True),
        "dataset_count": len(project.get("datasets") or []),
        "threads": threads,
    }
    if is_admin(user):
        base.update({
            "access": project.get("access", "everyone"),
            "members": project.get("members") or [],
            "created_by": project.get("created_by"),
            "updated_at": _iso(project.get("updated_at")),
            "datasets": [_dataset_info(n, uploads or {}, meta or {}) for n in project.get("datasets") or []],
        })
    else:
        base["datasets"] = [{"name": n} for n in project.get("datasets") or []]
    return base


def _thread_counts(username):
    rows = db["chat_threads"].aggregate([
        {"$match": {"username": username, "project": {"$type": "string"}}},
        {"$group": {"_id": "$project", "n": {"$sum": 1}}},
    ])
    return {row["_id"]: row["n"] for row in rows}


# --------------------------------------------------
# Endpoints
# --------------------------------------------------

@router.get("")
def list_projects(user=Depends(require_user)):
    counts = _thread_counts(user["username"])
    admin = is_admin(user)
    docs = list(projects.find({}).sort("name", 1))
    if not admin:
        docs = [p for p in docs if p.get("enabled", True) and can_use(user, p)]
        return {"projects": [_public(p, user, threads=counts.get(p["_id"], 0)) for p in docs]}

    uploads = {d["name"]: d for d in db["app_datasets"].find({}, {"_id": 0})}
    meta = {d["_id"]: d for d in catalog_meta.find({})}
    every = set(business_collection_names(include_disabled=True, scoped=False))
    assigned = {name for p in docs for name in p.get("datasets") or []}
    unassigned = [_dataset_info(n, uploads, meta) for n in sorted(every - assigned)]
    all_tags = sorted({t for p in docs for t in p.get("tags") or []} | {t for m in meta.values() for t in m.get("tags") or []})
    return {
        "projects": [_public(p, user, uploads, meta, counts.get(p["_id"], 0)) for p in docs],
        "unassigned": unassigned,
        "tags": all_tags,
        "categories": CATEGORIES,
        "users": sorted(u["username"] for u in db["app_users"].find({"disabled": {"$ne": True}}, {"username": 1})),
    }


class NewProject(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    description: str = Field(default="", max_length=500)
    category: str | None = Field(default=None, max_length=40)
    tags: list[str] = []
    enabled: bool = True
    access: str = "everyone"
    members: list[str] = []
    datasets: list[str] = []


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=60)
    description: str | None = Field(default=None, max_length=500)
    category: str | None = Field(default=None, max_length=40)
    tags: list[str] | None = None
    enabled: bool | None = None
    access: str | None = None
    members: list[str] | None = None


class DatasetList(BaseModel):
    datasets: list[str]


def _members(names):
    names = sorted({str(n).strip().lower() for n in names or [] if str(n).strip()})
    known = {u["username"] for u in db["app_users"].find({"username": {"$in": names}}, {"username": 1})}
    unknown = [n for n in names if n not in known]
    if unknown:
        raise _bad("unknown_user", f"Unknown user(s): {', '.join(unknown)}.")
    return names


def _check_access(access):
    if access not in {"everyone", "members"}:
        raise _bad("bad_request", "access must be 'everyone' or 'members'.")


def _check_datasets(names):
    every = set(business_collection_names(include_disabled=True, scoped=False))
    missing = [n for n in names if n not in every]
    if missing:
        raise _bad("unknown_dataset", f"Unknown dataset(s): {', '.join(missing)}.")
    return list(dict.fromkeys(names))


def _get(project_id):
    project = projects.find_one({"_id": project_id})
    if not project:
        raise _bad("not_found", "Project not found.", 404)
    return project


def _changed():
    invalidate_project_cache()
    clear_schema_cache()


def assign(project_id, names, admin=None):
    """Move datasets into a project (a dataset lives in one project only)."""

    names = _check_datasets(names)
    projects.update_many({"_id": {"$ne": project_id}}, {"$pull": {"datasets": {"$in": names}}})
    projects.update_one({"_id": project_id}, {"$addToSet": {"datasets": {"$each": names}},
                                              "$set": {"updated_at": _now()}})
    _changed()
    if admin:
        _audit(admin, "project.datasets.add", project_id, {"datasets": names})


@router.post("", status_code=201)
def create_project(payload: NewProject, admin=Depends(require_admin)):
    _check_access(payload.access)
    now = _now()
    doc = {
        "_id": _slug(payload.name),
        "name": payload.name.strip(),
        "description": payload.description.strip(),
        "category": (payload.category or "").strip() or None,
        "tags": _clean_tags(payload.tags),
        "enabled": payload.enabled,
        "access": payload.access,
        "members": _members(payload.members),
        "datasets": [],
        "created_by": admin["username"],
        "created_at": now,
        "updated_at": now,
    }
    projects.insert_one(doc)
    if payload.datasets:
        assign(doc["_id"], payload.datasets)
    _changed()
    _audit(admin, "project.create", doc["_id"], {"name": doc["name"], "datasets": payload.datasets})
    return _public(_get(doc["_id"]), admin, {}, {})


@router.patch("/{project_id}")
def update_project(project_id: str, payload: ProjectPatch, admin=Depends(require_admin)):
    _get(project_id)
    changes = payload.model_dump(exclude_none=True)
    if "access" in changes:
        _check_access(changes["access"])
    if "members" in changes:
        changes["members"] = _members(changes["members"])
    if "tags" in changes:
        changes["tags"] = _clean_tags(changes["tags"])
    for key in ("name", "description", "category"):
        if key in changes:
            changes[key] = changes[key].strip()
    if changes:
        projects.update_one({"_id": project_id}, {"$set": {**changes, "updated_at": _now()}})
        _changed()
        action = "project.enable" if changes.get("enabled") is True else (
            "project.disable" if changes.get("enabled") is False else "project.update")
        _audit(admin, action, project_id, changes)
    return _public(_get(project_id), admin, {d["name"]: d for d in db["app_datasets"].find({}, {"_id": 0})},
                   {d["_id"]: d for d in catalog_meta.find({})})


@router.delete("/{project_id}")
def delete_project(project_id: str, admin=Depends(require_admin)):
    project = _get(project_id)
    projects.delete_one({"_id": project_id})
    db["chat_threads"].update_many({"project": project_id}, {"$unset": {"project": ""}})
    _changed()
    _audit(admin, "project.delete", project_id, {"datasets": project.get("datasets") or []})
    return {"deleted": project_id, "unassigned": project.get("datasets") or []}


@router.put("/{project_id}/datasets")
def set_datasets(project_id: str, payload: DatasetList, admin=Depends(require_admin)):
    project = _get(project_id)
    names = _check_datasets(payload.datasets)
    projects.update_many({"_id": {"$ne": project_id}}, {"$pull": {"datasets": {"$in": names}}})
    projects.update_one({"_id": project_id}, {"$set": {"datasets": names, "updated_at": _now()}})
    _changed()
    _audit(admin, "project.datasets.set", project_id, {"before": project.get("datasets") or [], "after": names})
    return {"id": project_id, "datasets": names}


@router.post("/{project_id}/datasets/{name}")
def add_dataset(project_id: str, name: str, admin=Depends(require_admin)):
    _get(project_id)
    assign(project_id, [name], admin)
    return {"id": project_id, "datasets": _get(project_id).get("datasets")}


@router.delete("/{project_id}/datasets/{name}")
def remove_dataset(project_id: str, name: str, admin=Depends(require_admin)):
    _get(project_id)
    projects.update_one({"_id": project_id}, {"$pull": {"datasets": name}, "$set": {"updated_at": _now()}})
    _changed()
    _audit(admin, "project.datasets.remove", project_id, {"dataset": name})
    return {"id": project_id, "datasets": _get(project_id).get("datasets")}


@router.get("/{project_id}/threads")
def project_threads(project_id: str, user=Depends(require_user)):
    project = projects.find_one({"_id": project_id})
    if not project or not can_use(user, project):
        raise _bad("project_not_found", "That project does not exist or you do not have access to it.", 404)
    docs = db["chat_threads"].find({"username": user["username"], "project": project_id},
                                   {"title": 1, "updatedAt": 1, "createdAt": 1}).sort("updatedAt", -1).limit(50)
    return {"threads": [{"id": d["_id"], "title": d.get("title") or "New conversation",
                         "updatedAt": d.get("updatedAt") or d.get("createdAt")} for d in docs]}


class MetaPatch(BaseModel):
    tags: list[str] | None = None
    category: str | None = Field(default=None, max_length=40)
    label: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=500)


@meta_router.patch("/{name}")
def update_meta(name: str, payload: MetaPatch, admin=Depends(require_admin)):
    _check_datasets([name])
    changes = payload.model_dump(exclude_none=True)
    if "tags" in changes:
        changes["tags"] = _clean_tags(changes["tags"])
    if changes:
        catalog_meta.update_one({"_id": name}, {"$set": changes}, upsert=True)
        _audit(admin, "dataset.meta", name, changes)
    doc = catalog_meta.find_one({"_id": name}) or {}
    return {"name": name, "tags": doc.get("tags") or [], "category": doc.get("category")}
