import asyncio
import contextvars
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pymongo.errors import PyMongoError

from backend import account, admin, agents, artifacts, auth, data_catalog, feedback, opportunities, projects, threads
from backend.admin import require_admin
from backend.auth import require_user
from backend.chat_service import ChatRun, model_options, with_heartbeat
from backend.config import settings
from backend.db import db, ping, project_scope
from backend.guardrails import GuardrailViolation, check_question
from backend import analytics, dashboard, hr_analytics, insights, project_lab
from backend.langchain_agent import run_langchain_agent
from backend.jev_router import route_question
from backend.observability import logger, metrics_snapshot
from backend.openui_engine import ASSET_DIR
from backend.openui_validator import status as validator_status
from backend.openui_validator import validate as validate_openui


@asynccontextmanager
async def lifespan(app):
    startup()
    yield
    executor.shutdown(wait=False, cancel_futures=True)


# Interactive API docs are off unless EXPOSE_API_DOCS=true (local development).
_docs = settings.expose_api_docs
app = FastAPI(title="Queryable Chatbot API", lifespan=lifespan,
              docs_url="/docs" if _docs else None, redoc_url="/redoc" if _docs else None,
              openapi_url="/openapi.json" if _docs else None)

# Legacy static UI files are kept on disk for reference, but the single user
# interface is the OpenUI frontend in openui_test/ (see "/" below).
app.mount(
    "/static",
    StaticFiles(directory="backend/static"),
    name="static"
)

app.include_router(auth.router)
app.include_router(threads.router)
app.include_router(account.router)
app.include_router(feedback.router)
app.include_router(artifacts.router)
app.include_router(admin.router)
app.include_router(agents.router)
app.include_router(data_catalog.router)
app.include_router(projects.router)
app.include_router(projects.meta_router)
app.include_router(opportunities.router)

executor = ThreadPoolExecutor(max_workers=4)


# --------------------------------------------------
# Startup and request protection
# --------------------------------------------------

def startup():
    try:
        auth.ensure_indexes()
        threads.ensure_indexes()
        account.ensure_indexes()
        feedback.ensure_indexes()
        artifacts.ensure_indexes()
        data_catalog.ensure_indexes()
        projects.ensure_indexes()
        created = projects.bootstrap_defaults()
        if created:
            logger.info("Created %s default project(s) for the sample data", created)
    except Exception as error:  # MongoDB down: the API still starts
        logger.warning("MongoDB index setup skipped: %s", error)

    # Start the official OpenUI validator now instead of on the first answer.
    threading.Thread(
        target=validate_openui, args=("root = Card([])",), daemon=True
    ).start()

    missing = [
        name for name, value in (
            ("OPENROUTER_API_KEY", settings.openrouter_api_key),
        ) if not value
    ]
    if missing:
        logger.warning("Missing configuration: %s", ", ".join(missing))
    if not settings.cookie_secure and settings.frontend_url.startswith("https://"):
        logger.warning("COOKIE_SECURE is off but FRONTEND_URL uses HTTPS; set COOKIE_SECURE=true.")


def _allowed_origins():
    origins = {settings.frontend_url.rstrip("/")}
    parsed = urlparse(settings.frontend_url)
    if parsed.hostname == "localhost":
        origins.add(settings.frontend_url.replace("localhost", "127.0.0.1").rstrip("/"))
    elif parsed.hostname == "127.0.0.1":
        origins.add(settings.frontend_url.replace("127.0.0.1", "localhost").rstrip("/"))
    return origins


@app.middleware("http")
async def reject_cross_site_writes(request: Request, call_next):
    """CSRF protection: state-changing API calls must come from the app."""

    if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.url.path.startswith("/api/"):
        origin = request.headers.get("origin")
        if origin and origin.rstrip("/") not in _allowed_origins():
            return JSONResponse(
                {"detail": {"code": "forbidden_origin", "message": "Cross-site request blocked."}},
                status_code=403,
            )
    return await call_next(request)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """API responses must never be cached or framed, wherever they are served from."""

    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    detail = exc.detail
    if not isinstance(detail, dict):
        detail = {"code": "error", "message": str(detail)}
    # OpenUI's error helpers read `error.message`.
    return JSONResponse({"detail": detail, "error": detail}, status_code=exc.status_code)


@app.exception_handler(PyMongoError)
async def database_error(request: Request, exc: PyMongoError):
    """MongoDB down or unreachable: a clear 503 instead of a 500 traceback."""

    # The connection string can contain credentials: never put it in a response.
    logger.warning("MongoDB error on %s: %s", request.url.path, type(exc).__name__)
    detail = {
        "code": "database_unavailable",
        "message": "The database is not reachable right now. Please try again shortly.",
    }
    return JSONResponse({"detail": detail, "error": detail}, status_code=503)


# --------------------------------------------------
# Public endpoints
# --------------------------------------------------

@app.get("/")
def home():
    return RedirectResponse(settings.frontend_url)


@app.get("/api/livez")
def livez():
    """Liveness probe: the process is up and serving requests."""

    return {"status": "ok"}


@app.get("/api/readyz")
def readyz():
    """Readiness probe: MongoDB answers and an LLM key is configured."""

    try:
        mongodb_ok = ping()
    except Exception:  # noqa: BLE001
        mongodb_ok = False
    ready = mongodb_ok and bool(settings.openrouter_api_key)
    # Public probe: no configuration details (admins see them in the Admin console).
    return JSONResponse({"status": "ready" if ready else "not_ready"}, status_code=200 if ready else 503)


@app.get("/api/health")
def health():
    try:
        mongodb = "ok" if ping() else "unavailable"
    except Exception:  # noqa: BLE001
        mongodb = "unavailable"

    # Public: the login page only needs to know whether MongoDB answers.
    # Providers, integrations and validator state are not disclosed here.
    return {"status": "ok", "mongodb": mongodb}


@app.get("/api/health/details")
def health_details(user=Depends(require_admin)):
    """Configuration overview for administrators (not public)."""

    return {
        **health(),
        "openrouter_configured": bool(settings.openrouter_api_key),
        "openui_provider": settings.openui_provider,
        "thesys_configured": bool(settings.thesys_api_key),
        "openui_assets": (ASSET_DIR / "system_prompt.txt").exists(),
        "openui_validator": validator_status(),
        "jev_enabled": settings.jev_enabled,
        "graphiti_enabled": settings.graphiti_enabled,
        "langfuse_enabled": bool(settings.langfuse_public_key and settings.langfuse_secret_key),
    }


# --------------------------------------------------
# Per-user request rate limit for the LLM endpoints
# --------------------------------------------------

_recent_requests = {}
_recent_lock = threading.Lock()


def check_rate_limit(user):
    """At most CHAT_REQUESTS_PER_MINUTE chat/ask requests per user per minute."""

    limit = settings.chat_requests_per_minute
    if limit <= 0:
        return
    now = time.monotonic()
    with _recent_lock:
        recent = [stamp for stamp in _recent_requests.get(user["username"], []) if now - stamp < 60]
        if len(recent) >= limit:
            _recent_requests[user["username"]] = recent
            retry = max(1, int(60 - (now - recent[0])))
            raise HTTPException(
                status_code=429,
                detail={"code": "rate_limited",
                        "message": f"Too many questions in a short time. Try again in {retry} seconds."},
                headers={"Retry-After": str(retry)},
            )
        recent.append(now)
        _recent_requests[user["username"]] = recent


def trusted_messages(client_messages, stored_thread):
    """Conversation history the server can vouch for.

    The browser resends the whole conversation on every turn. Earlier turns
    are taken from the stored thread (matched by message id) so a client
    cannot forge "assistant" or earlier "user" turns to steer the model;
    only the new, final user message comes from the request.
    """

    known = {
        message["id"]: message
        for message in ((stored_thread or {}).get("messages") or [])
        if isinstance(message, dict) and message.get("id")
    }
    history = [
        known[message["id"]]
        for message in client_messages[:-1]
        if isinstance(message, dict) and message.get("id") in known
    ]
    return history + [client_messages[-1]]


# --------------------------------------------------
# Authenticated endpoints
# --------------------------------------------------

@app.get("/api/models")
def models(user=Depends(require_user)):
    return {"default": settings.openui_model, "models": model_options(user)}


@app.get("/api/metrics")
def metrics(user=Depends(require_admin)):
    return metrics_snapshot()


def _data_call(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except ValueError as error:
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": str(error)})
    except Exception as error:  # noqa: BLE001 - MongoDB unavailable
        logger.warning("data endpoint failed: %s", error)
        raise HTTPException(status_code=503, detail={"code": "database_unavailable",
                                                     "message": "The database is not reachable right now."})


DATASETS = {"span": (insights.overview, analytics.lab), "ibm_hr": (hr_analytics.overview, hr_analytics.lab)}
# The collection each fixed dashboard reads; the user must be allowed to read it.
DATASET_COLLECTIONS = {"span": "span_companies", "ibm_hr": "ibm_hr_employees"}


def _dataset(name):
    if name not in DATASETS:
        raise HTTPException(status_code=400, detail={"code": "bad_request",
                                                     "message": f"Unknown dataset. Use one of: {', '.join(DATASETS)}."})
    return DATASETS[name]


@app.get("/api/datasets")
async def datasets(user=Depends(require_user)):
    """Datasets the Insights dashboard and Analytics lab can switch between."""

    allowed = await asyncio.to_thread(projects.allowed_collections, user, None)
    every = await asyncio.to_thread(hr_analytics.datasets)
    return {"datasets": [d for d in every if DATASET_COLLECTIONS.get(d["id"]) in allowed]}


async def _scoped(user, project, function, *args):
    """Run a data helper limited to what this user may read (and the chosen project).

    asyncio.to_thread copies the current context, so the scope set here is
    the one every schema read inside ``function`` sees.
    """

    allowed = await asyncio.to_thread(projects.allowed_collections, user, project or None)
    with project_scope(allowed):
        return await asyncio.to_thread(_data_call, function, *args)


async def _scoped_dataset(user, project, dataset, function):
    """Like _scoped, but refuses when the dashboard's collection is outside the
    user's projects (restricted, switched off, or not in the chosen project)."""

    allowed = await asyncio.to_thread(projects.allowed_collections, user, project or None)
    name = DATASET_COLLECTIONS[dataset]
    # A collection that does not exist has nothing to leak (the dashboard shows
    # an empty state); an existing one must be inside the user's projects.
    if name not in allowed and name in await asyncio.to_thread(db.list_collection_names):
        raise HTTPException(status_code=404, detail={"code": "not_available",
                                                     "message": "This dataset is not available to you."})
    with project_scope(allowed):
        return await asyncio.to_thread(_data_call, function)


@app.get("/api/insights/overview")
async def insights_overview(dataset: str = "span", project: str | None = None, user=Depends(require_user)):
    """KPI tiles, chart panels, maps and headline insights for the dashboard."""

    overview, _ = _dataset(dataset)
    return await _scoped_dataset(user, project, dataset, overview)


@app.get("/api/analytics/lab")
async def analytics_lab(dataset: str = "span", project: str | None = None, user=Depends(require_user)):
    """Relationship views, statistics and forecast for the Analytics lab page."""

    _, lab = _dataset(dataset)
    return await _scoped_dataset(user, project, dataset, lab)


@app.get("/api/analytics/project-lab")
async def analytics_project_lab(project: str | None = None, user=Depends(require_user)):
    """Animated analytics for any project's company data (VAF samples and uploads)."""

    return await _scoped(user, project, project_lab.lab)


@app.get("/api/analytics/dataset-lab")
async def analytics_dataset_lab(collection: str, project: str | None = None, user=Depends(require_user)):
    """Animated deep dive into one dataset (any kind: companies, employees, orders)."""

    return await _scoped(user, project, project_lab.dataset_lab, collection)


@app.get("/api/dashboard")
async def project_dashboard(project: str | None = None, collection: str | None = None, user=Depends(require_user)):
    """Auto-built dashboard (KPIs + charts) for a project or one of its datasets."""

    return await _scoped(user, project, dashboard.build, collection)


@app.get("/api/geo/datasets")
async def geo_datasets(project: str | None = None, user=Depends(require_user)):
    return {"datasets": await _scoped(user, project, insights.geo_datasets)}


@app.get("/api/geo/explore")
async def geo_explore(collection: str, place_field: str, value_field: str | None = None,
                      op: str = "count", project: str | None = None, user=Depends(require_user)):
    payload = await _scoped(user, project, insights.geo_explore, collection, place_field, value_field, op)
    return payload or {"places": [], "insights": [], "continents": []}


@app.post("/api/chat")
async def chat(request: Request, user=Depends(require_user)):
    """OpenUI chat endpoint (AG-UI RunAgentInput in, AG-UI SSE out)."""

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "Invalid JSON body."})

    messages = body.get("messages")
    thread_id = body.get("threadId")

    if not isinstance(messages, list) or not messages or not isinstance(messages[-1], dict):
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "messages must be a non-empty list."})
    if messages[-1].get("role") != "user":
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "The last message must be from the user."})

    check_rate_limit(user)

    stored = await asyncio.to_thread(threads.get_owned, thread_id, user["username"]) if thread_id else None
    messages = trusted_messages(messages, stored)

    # Project scope: only the user's authorised datasets in active projects,
    # narrowed to the selected project when there is one. Checked before the
    # stream starts so a disabled or forbidden project is a clear 4xx.
    project = body.get("project") or None
    if project is not None and not isinstance(project, str):
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "project must be a string."})
    scope = await asyncio.to_thread(projects.allowed_collections, user, project)

    run = ChatRun(user, thread_id, messages, body.get("model"), project=project, scope=scope)

    return StreamingResponse(
        with_heartbeat(run.events()),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


class QuestionRequest(BaseModel):
    question: str
    project: str | None = None


def log_jev_result(question, jev_future, started_at):
    """Log Jev's result when the background request finishes."""
    elapsed = time.perf_counter() - started_at
    try:
        result = jev_future.result()
        logger.info("/ask jev finished in %.2fs: %s", elapsed, result)
    except Exception as error:  # noqa: BLE001
        logger.warning("/ask jev failed after %.2fs: %s", elapsed, type(error).__name__)


@app.post("/ask")
@app.post("/api/ask")  # same endpoint, reachable through the frontend's /api proxy
async def ask_question(request: QuestionRequest, user=Depends(require_user)):
    """Plain-text answer endpoint kept for scripts and the evaluation runner."""

    start_time = time.perf_counter()
    check_rate_limit(user)
    try:
        question = check_question(request.question)
    except GuardrailViolation as violation:
        raise HTTPException(status_code=400, detail={"code": violation.code, "message": violation.message})

    try:
        await asyncio.to_thread(account.count_message, user)
    except account.QuotaExceeded as limit:
        raise HTTPException(status_code=429, detail={"code": "quota_exceeded", "message": limit.message})

    loop = asyncio.get_running_loop()
    allowed = await asyncio.to_thread(projects.allowed_collections, user, request.project)

    # Start Jev in the background and log it when it finishes, without
    # delaying the answer.
    jev_started = time.perf_counter()
    jev_future = executor.submit(route_question, question)
    jev_future.add_done_callback(lambda future: log_jev_result(question, future, jev_started))

    try:
        # run_in_executor does not carry context variables: run inside a copied context.
        with project_scope(allowed):
            context = contextvars.copy_context()
        answer = await loop.run_in_executor(executor, context.run, run_langchain_agent, question)
    except Exception:
        logger.exception("/ask failed after %.2fs", time.perf_counter() - start_time)
        raise

    logger.info("/ask answered in %.2fs", time.perf_counter() - start_time)
    return {"answer": answer}
