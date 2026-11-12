"""Shared MongoDB client and the "which collections may the chatbot read" gate.

One client is reused by the query tool, schema discovery, authentication and
thread storage, so connection settings live in one place.

``business_collection_names`` is the single gate every reader goes through
(schema discovery, the query validator, dashboards). It applies, in order:

1. internal ``app_*`` collections are never exposed;
2. the optional ``QUERYABLE_COLLECTIONS`` allowlist (uploaded datasets always pass);
3. datasets inside a project an admin switched **off** are hidden everywhere;
4. the request's project scope: a chat started inside a project only sees
   that project's datasets (set with ``project_scope``).
"""

import contextvars
import threading
import time
from contextlib import contextmanager

from pymongo import MongoClient

from backend.config import INTERNAL_COLLECTIONS, settings

client = MongoClient(
    settings.mongodb_uri,
    # Fail fast when MongoDB is down, so the UI can say so instead of hanging.
    serverSelectionTimeoutMS=3000,
    connectTimeoutMS=5000,
)

db = client[settings.mongodb_db]

# Connection used for model-generated queries and schema sampling. With
# MONGODB_READONLY_URI set to a user holding only the ``read`` role, MongoDB
# itself refuses any write, even if a query ever got past the validator.
read_client = (
    MongoClient(settings.mongodb_readonly_uri, serverSelectionTimeoutMS=3000, connectTimeoutMS=5000)
    if settings.mongodb_readonly_uri
    else client
)
read_db = read_client[settings.mongodb_db]

# Collections of the current request's project (None = every enabled dataset).
_scope = contextvars.ContextVar("qc_project_scope", default=None)

# Disabled-project lookups happen on every schema read; cache them briefly.
_PROJECT_CACHE_SECONDS = 15
_project_cache = {"disabled": frozenset(), "expires": 0.0}
_project_lock = threading.Lock()


def invalidate_project_cache():
    with _project_lock:
        _project_cache["expires"] = 0.0


def disabled_collections():
    """Datasets that belong to a project an admin has switched off."""

    now = time.monotonic()
    with _project_lock:
        if now < _project_cache["expires"]:
            return _project_cache["disabled"]
    names = set()
    try:
        for project in db["app_projects"].find({"enabled": False}, {"datasets": 1}):
            names.update(project.get("datasets") or [])
    except Exception:  # noqa: BLE001 - MongoDB down: callers fail on their own read
        names = set()
    with _project_lock:
        _project_cache["disabled"] = frozenset(names)
        _project_cache["expires"] = time.monotonic() + _PROJECT_CACHE_SECONDS
    return _project_cache["disabled"]


def current_scope():
    """frozenset of collections the current request is limited to, or None."""

    return _scope.get()


def set_scope(collections):
    """Limit this context to ``collections`` (None clears). Returns a reset token."""

    return _scope.set(frozenset(collections) if collections is not None else None)


def reset_scope(token):
    try:
        _scope.reset(token)
    except ValueError:  # reset from another context (generator closed elsewhere)
        _scope.set(None)


@contextmanager
def project_scope(collections):
    token = set_scope(collections)
    try:
        yield
    finally:
        reset_scope(token)


def _base_collection_names():
    names = [
        name
        for name in db.list_collection_names()
        if name not in INTERNAL_COLLECTIONS and not name.startswith("system.")
        and not name.endswith("__staging")  # an upload in progress (data_catalog.import_file)
    ]

    if settings.queryable_collections:
        # Datasets an admin uploaded from the Data catalog are always
        # queryable; the allowlist only narrows the other collections.
        allowed = set(settings.queryable_collections) | set(db["app_datasets"].distinct("name"))
        names = [name for name in names if name in allowed]

    return names


def business_collection_names(include_disabled=False, scoped=True):
    """Collections the chatbot is allowed to read for analytics."""

    names = set(_base_collection_names())
    if not include_disabled:
        names -= disabled_collections()
    scope = current_scope() if scoped else None
    if scope is not None:
        names &= scope
    return sorted(names)


def ping():
    client.admin.command("ping")
    return True
