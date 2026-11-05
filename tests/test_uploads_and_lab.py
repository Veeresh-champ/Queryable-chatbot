"""More file types, "use without saving", overview queries, honest gaps, project lab."""

import io
import json
from datetime import datetime, timedelta, timezone

import pytest

from backend import admin, chat_service, data_catalog, projects
from backend.auth import create_user, sessions, users
from backend.db import db, invalidate_project_cache, project_scope
from backend.schema_discovery import clear_schema_cache
from backend.validator import validate_query
from tests.conftest import sse_events

ADMIN = {"username": "uploadboss", "password": "admin-password-123"}
ROWS = [
    {"Company Name": "Acme", "Country": "USA", "Locations": "120+", "Online Quote": "No", "Info": {"tier": "gold"}},
    {"Company Name": "Beta", "Country": "INDIA", "Locations": "8", "Online Quote": "Yes", "Info": {"tier": "silver"}},
    {"Company Name": "Gamma", "Country": "CANADA", "Locations": "60+", "Online Quote": "Yes", "Info": {"tier": "gold"}},
]


@pytest.fixture()
def admin_client(app_client, user):
    users.delete_many({"username": ADMIN["username"]})
    create_user(ADMIN["username"], ADMIN["password"], "Upload Boss", role="admin")
    assert app_client.post("/api/auth/login", json=ADMIN).status_code == 200
    yield app_client
    for doc in data_catalog.datasets.find({}, {"name": 1}):
        db[doc["name"]].drop()
    data_catalog.datasets.delete_many({})
    projects.projects.delete_many({"created_by": ADMIN["username"]})
    projects.catalog_meta.delete_many({})
    users.delete_many({"username": ADMIN["username"]})
    sessions.delete_many({"username": ADMIN["username"]})
    admin.audit_log.delete_many({})
    invalidate_project_cache()
    clear_schema_cache()


def _file(name, content):
    return {"file": (name, io.BytesIO(content), "application/octet-stream")}


@pytest.mark.parametrize("name,content", [
    ("accounts.json", json.dumps(ROWS).encode()),
    ("accounts.jsonl", "\n".join(json.dumps(r) for r in ROWS).encode()),
    ("accounts.json", json.dumps({"data": ROWS, "count": 3}).encode()),
    ("accounts.tsv", "Company Name\tCountry\tLocations\nAcme\tUSA\t120+\nBeta\tINDIA\t8\nGamma\tCANADA\t60+\n".encode()),
    ("accounts.txt", "Company Name|Country|Locations\nAcme|USA|120+\nBeta|INDIA|8\nGamma|CANADA|60+\n".encode()),
])
def test_more_file_types_preview(admin_client, name, content):
    response = admin_client.post("/api/catalog/preview", files=_file(name, content))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["rows"] == 3
    columns = {c["name"] for c in body["columns"]}
    assert {"company_name", "country", "locations", "locations_num"} <= columns
    if name.endswith((".json", ".jsonl")):
        assert "info_tier" in columns and body["preview"][0]["online_quote"] is False


def test_bad_json_is_a_clear_error(admin_client):
    response = admin_client.post("/api/catalog/preview", files=_file("x.json", b'{"a": 1}\n{oops'))
    assert response.status_code == 400 and "Line 2" in response.json()["detail"]["message"]


def test_use_without_saving_expires_and_keep_saves(admin_client):
    up = admin_client.post("/api/catalog/upload", files=_file("temp.json", json.dumps(ROWS).encode()),
                           data={"name": "t_temp", "temporary": "true"})
    assert up.status_code == 201 and up.json()["temporary"] is True
    meta = {c["name"]: c for c in admin_client.get("/api/catalog").json()["collections"]}["t_temp"]["dataset"]
    assert meta["temporary"] is True and meta["expires_at"]
    # Queryable straight away.
    assert "t_temp" in projects.allowed_collections({"username": "x", "role": "analyst"})

    # Keep makes it permanent.
    assert admin_client.post("/api/catalog/t_temp/keep").json()["dataset"]["temporary"] is False
    assert data_catalog.purge_expired(datetime.now(timezone.utc) + timedelta(days=2)) == []

    # A temporary one that has expired is removed with its rows.
    admin_client.post("/api/catalog/upload", files=_file("temp2.json", json.dumps(ROWS).encode()),
                      data={"name": "t_temp2", "temporary": "true"})
    assert data_catalog.purge_expired(datetime.now(timezone.utc) + timedelta(hours=25)) == ["t_temp2"]
    assert "t_temp2" not in db.list_collection_names()
    assert data_catalog.datasets.find_one({"name": "t_temp2"}) is None


def test_overview_query_with_distinct_count_is_allowed(mongo):
    query = {"collection": "span_companies", "operation": "aggregate", "pipeline": [
        {"$group": {"_id": None, "n": {"$sum": 1}, "countries": {"$addToSet": "$country"}, "sd": {"$stdDevPop": "$employee_count"}}},
        {"$project": {"_id": 0, "n": 1, "unique_countries": {"$size": "$countries"}, "sd": 1}},
    ]}
    assert validate_query(query)
    for stage in ({"$out": "x"}, {"$merge": {"into": "x"}}, {"$match": {"$where": "1"}},
                  {"$addFields": {"a": {"$function": {"body": "", "args": [], "lang": "js"}}}}):
        assert not validate_query({"collection": "span_companies", "operation": "aggregate", "pipeline": [stage]})


def test_question_about_missing_field_gets_an_honest_answer(logged_in, monkeypatch):
    from dataclasses import replace

    from backend import langchain_agent

    monkeypatch.setattr(chat_service, "settings",
                        replace(chat_service.settings, jev_enabled=False, openrouter_api_key="test-key"))
    monkeypatch.setattr(langchain_agent, "is_database_question", lambda q: True)
    monkeypatch.setattr(langchain_agent, "generate_database_query", lambda q, repair=None: {"unanswerable": "insurance premiums"})

    async def must_not_run(*args, **kwargs):  # no answer model call is needed
        raise AssertionError("the answer model should not run")
        yield ""

    monkeypatch.setattr(chat_service, "stream_openui", must_not_run)
    body = {"messages": [{"role": "user", "content": "Total insurance premiums by country"}]}
    with logged_in.stream("POST", "/api/chat", json=body) as response:
        events = sse_events(response)
    text = "".join(e.get("delta", "") for e in events if e["type"] == "TEXT_MESSAGE_CONTENT")
    assert "insurance premiums" in text and "doesn" in text


def test_project_lab_for_uploaded_company_data(admin_client):
    p = admin_client.post("/api/projects", json={"name": "Lab test"}).json()["id"]
    admin_client.post("/api/catalog/upload", files=_file("accounts.json", json.dumps(ROWS).encode()),
                      data={"name": "t_lab", "project": p})
    lab = admin_client.get(f"/api/analytics/project-lab?project={p}").json()
    assert lab["available"] and len(lab["accounts"]) == 3
    assert {k["id"] for k in lab["kpis"]} == {"accounts", "countries", "opportunity", "completeness"}
    assert lab["chord"]["names"][-1] == "T Lab"
    assert any(row["capability"] == "Online quote" for row in lab["waffle"])
    with project_scope(projects.allowed_collections({"username": "x", "role": "admin"}, p)):
        from backend.project_lab import lab as build
        assert build()["accounts"][0]["name"] == "Acme"
