"""Shared test setup.

Unit and integration tests run against a separate MongoDB database
(``queryable_chatbot_test``) so they never touch real users, threads or
business data. External services (OpenRouter, Jev, Thesys) are mocked
unless a test is marked ``live``.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Must be set before any backend module is imported.
os.environ["MONGODB_DB"] = "queryable_chatbot_test"
os.environ["QUERYABLE_LOG_DIR"] = str(ROOT / "logs" / "test")
os.environ.setdefault("LOGIN_MAX_ATTEMPTS", "3")
os.environ.setdefault("LOGIN_LOCKOUT_SECONDS", "60")

import pytest  # noqa: E402

from backend.db import client  # noqa: E402

TEST_DB = "queryable_chatbot_test"

SPAN_ROWS = [
    {"company_id": "S1", "company_name": "Alpha", "country": "India", "deployment_type": "SaaS",
     "annual_hr_tech_spend_usd": 1000.0, "employee_count": 50, "contact_email": "ceo@alpha.example"},
    {"company_id": "S2", "company_name": "Beta", "country": "India", "deployment_type": "Hybrid",
     "annual_hr_tech_spend_usd": 3000.0, "employee_count": 120, "contact_email": "hr@beta.example"},
    {"company_id": "S3", "company_name": "Gamma", "country": "United States", "deployment_type": "Hybrid",
     "annual_hr_tech_spend_usd": 5000.0, "employee_count": 900, "contact_email": "it@gamma.example"},
]


def mongo_available():
    try:
        client.admin.command("ping")
        return True
    except Exception:  # noqa: BLE001
        return False


def pytest_configure(config):
    config.addinivalue_line("markers", "live: calls real external services (OpenRouter/Jev)")


@pytest.fixture(scope="session")
def mongo():
    if not mongo_available():
        pytest.skip("MongoDB is not running")
    db = client[TEST_DB]
    for name in db.list_collection_names():
        db.drop_collection(name)
    db["span_companies"].insert_many([dict(row) for row in SPAN_ROWS])

    from backend import auth, threads
    from backend.schema_discovery import clear_schema_cache

    auth.ensure_indexes()
    threads.ensure_indexes()
    clear_schema_cache()
    yield db
    client.drop_database(TEST_DB)


@pytest.fixture()
def app_client(mongo):
    from fastapi.testclient import TestClient

    import backend.main as main

    with TestClient(main.app) as test_client:
        yield test_client


@pytest.fixture()
def user(mongo):
    from backend.auth import create_user, users

    users.delete_many({"username": "tester"})
    create_user("tester", "correct-horse-battery", "Tester")
    yield {"username": "tester", "password": "correct-horse-battery"}
    users.delete_many({"username": "tester"})


@pytest.fixture()
def logged_in(app_client, user):
    response = app_client.post("/api/auth/login", json=user)
    assert response.status_code == 200
    return app_client


def sse_events(response):
    import json

    events = []
    for line in response.iter_lines():
        if line.startswith("data: "):
            events.append(json.loads(line[6:]))
    return events


@pytest.fixture(autouse=True)
def _clear_query_cache():
    from backend import chat_service

    chat_service._QUERY_CACHE.clear()
    yield
    chat_service._QUERY_CACHE.clear()
