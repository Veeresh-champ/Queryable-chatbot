"""Projects, isolation, permissions, VAF-style ingestion and use-case insights."""

import io
import json
from datetime import date, timedelta

import pytest

from backend import admin, chat_service, data_catalog, opportunities, projects
from backend.auth import create_user, sessions, users
from backend.db import db, invalidate_project_cache, project_scope
from backend.schema_discovery import clear_schema_cache, get_schema
from backend.validator import validate_query
from tests.conftest import sse_events

ADMIN = {"username": "projboss", "password": "admin-password-123"}
MEMBER = {"username": "member1", "password": "member-password-123"}

# A small "VAF"-style sheet: human-written numbers, yes/no capabilities, a
# repeated company, a broken dash character and a money column with mixed units.
INSURANCE = (
    "ID,Company Name,Country,Number of Locations,Number of Agents (Est),Online Quote(Yes/No),Mobile App(Yes/No),"
    "Service Geography,Total Assets (USD)\n"
    "1,Acme Mutual,USA,50+,\"1,000+\",Yes,Yes,Global,$4B\n"
    "2,Beta Insure,USA,3,5�20,No,No,United States,388.8\n"
    "3,Gamma Life,INDIA,200+,\"50,000+\",Yes,Yes,India,$12B\n"
    "4,Delta Cover,CANADA,10+,500+,Yes,No,North America / Global,4627\n"
    "5,Acme Mutual,USA,50+,\"1,000+\",Yes,Yes,Global,$4B\n"
).encode()
RETAIL = (
    "Company Name,Country,Rating (Approx),Number of Reviews (Approx),Delivery,Payment Type\n"
    "Shop One,USA,3.6/5,8K+,Yes (Home Delivery),Cash\n"
    "Shop Two,UNITED KINGDOM,4.5/5,1M+,No,\"Credit, Debit, Mobile Payments\"\n"
    "Shop Three,USA,4.3/5,500K+,Yes,\"Credit, UPI\"\n"
).encode()


def _file(name, content):
    return {"file": (name, io.BytesIO(content), "text/csv")}


@pytest.fixture()
def admin_client(app_client, user):
    for who in (ADMIN, MEMBER):
        users.delete_many({"username": who["username"]})
    create_user(ADMIN["username"], ADMIN["password"], "Proj Boss", role="admin")
    create_user(MEMBER["username"], MEMBER["password"], "Member One")
    assert app_client.post("/api/auth/login", json=ADMIN).status_code == 200
    yield app_client
    for doc in data_catalog.datasets.find({}, {"name": 1}):
        db[doc["name"]].drop()
    data_catalog.datasets.delete_many({})
    projects.projects.delete_many({"created_by": ADMIN["username"]})
    projects.catalog_meta.delete_many({})
    for who in (ADMIN, MEMBER):
        users.delete_many({"username": who["username"]})
        sessions.delete_many({"username": who["username"]})
    admin.audit_log.delete_many({})
    invalidate_project_cache()
    clear_schema_cache()


def _login(client, who):
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json=who).status_code == 200


def _setup_two_projects(client):
    a = client.post("/api/projects", json={"name": "Insurance VAF", "tags": ["VAF", "insurance"],
                                           "category": "Market intelligence"}).json()
    b = client.post("/api/projects", json={"name": "Retail VAF"}).json()
    up = client.post("/api/catalog/upload", files=_file("insurance.csv", INSURANCE),
                     data={"name": "t_insurance", "project": a["id"], "tags": "vaf,insurance"})
    assert up.status_code == 201, up.text
    up = client.post("/api/catalog/upload", files=_file("retail.csv", RETAIL),
                     data={"name": "t_retail", "project": b["id"]})
    assert up.status_code == 201, up.text
    return a["id"], b["id"]


# ---------------------------------------------------------------- parsing

@pytest.mark.parametrize("text,money,expected", [
    ("1,000+", False, 1000), ("100K�300K", False, 100_000), ("$1.26B", True, 1.26e9), ("4.3/5", False, 4.3),
    ("$40–60M", True, 40e6), ("500,000�1M", False, 500_000), ("1 Million+ clients", False, 1e6),
    ("48,000+ corporate clients (80M+ users)", False, 48_000), ("4627", True, None), ("Corporate Only", False, None),
])
def test_parse_amount_reads_lower_bounds_and_never_guesses_units(text, money, expected):
    assert data_catalog.parse_amount(text, money)[0] == expected


def test_preview_reports_quality_and_derived_fields(admin_client):
    body = admin_client.post("/api/catalog/preview", files=_file("insurance.csv", INSURANCE)).json()
    columns = {c["name"]: c for c in body["columns"]}
    assert columns["number_of_agents_est_num"]["derived_from"] == "number_of_agents_est"
    assert columns["online_quote_yes_no"]["type"] == "bool"
    codes = {i["code"] for i in body["quality"]["issues"]}
    assert {"duplicate_rows", "repeated_accounts", "broken_characters", "derived_fields"} <= codes
    # '388.8' / '4627' next to '$4B': dollars or millions? Those values get no
    # number (flagged), while '$4B' / '$12B' are read.
    rows = {r["company_name"]: r for r in body["preview"]}
    assert rows["Gamma Life"]["total_assets_usd_num"] == 12e9
    assert "total_assets_usd_num" not in rows["Beta Insure"] and "total_assets_usd_num" not in rows["Delta Cover"]
    assert any(i["code"] == "mixed_units" and "total_assets_usd" in i["columns"] for i in body["quality"]["issues"])
    # The preview writes nothing.
    assert "insurance" not in db.list_collection_names()


def test_upload_into_project_with_tags_keeps_original_text(admin_client):
    a, _ = _setup_two_projects(admin_client)
    doc = db["t_insurance"].find_one({"company_name": "Beta Insure"}, {"_id": 0})
    assert doc["number_of_agents_est"] == "5�20" and doc["number_of_agents_est_num"] == 5
    assert "t_insurance__staging" not in db.list_collection_names()
    listing = admin_client.get("/api/projects").json()
    project = next(p for p in listing["projects"] if p["id"] == a)
    assert [d["name"] for d in project["datasets"]] == ["t_insurance"]
    assert project["datasets"][0]["tags"] == ["vaf", "insurance"]
    assert project["tags"] == ["vaf", "insurance"]
    catalog = {c["name"]: c for c in admin_client.get("/api/catalog").json()["collections"]}
    assert catalog["t_insurance"]["project"] == a and catalog["t_insurance"]["active"] is True


def test_upload_to_unknown_project_writes_nothing(admin_client):
    response = admin_client.post("/api/catalog/upload", files=_file("x.csv", RETAIL),
                                 data={"name": "t_orphan", "project": "nope"})
    assert response.status_code == 404
    assert "t_orphan" not in db.list_collection_names()


# ---------------------------------------------------------------- management & permissions

def test_only_admins_manage_projects(logged_in):
    assert logged_in.post("/api/projects", json={"name": "Nope"}).status_code == 403
    assert logged_in.patch("/api/projects/span-hr-tech", json={"enabled": False}).status_code == 403
    assert logged_in.delete("/api/projects/span-hr-tech").status_code == 403
    assert logged_in.patch("/api/catalog-meta/span_companies", json={"tags": ["x"]}).status_code == 403


def test_dataset_lives_in_one_project_and_moves(admin_client):
    a, b = _setup_two_projects(admin_client)
    assert admin_client.post(f"/api/projects/{b}/datasets/t_insurance").status_code == 200
    assert projects.projects.find_one({"_id": a})["datasets"] == []
    assert set(projects.projects.find_one({"_id": b})["datasets"]) == {"t_retail", "t_insurance"}
    # Deleting the project keeps the data: the datasets become unassigned.
    assert admin_client.delete(f"/api/projects/{b}").json()["unassigned"]
    assert "t_insurance" in db.list_collection_names()
    actions = [e["action"] for e in admin.audit_log.find({"actor": ADMIN["username"]})]
    assert "project.create" in actions and "project.delete" in actions


def test_project_scope_isolates_schema_and_validator(admin_client):
    a, b = _setup_two_projects(admin_client)
    me = users.find_one({"username": MEMBER["username"]})
    with project_scope(projects.allowed_collections(me, a)):
        schema = get_schema()
        assert "t_insurance" in schema and "t_retail" not in schema and "span_companies" not in schema
        assert validate_query({"collection": "t_insurance", "operation": "count", "filters": {}})
        assert not validate_query({"collection": "t_retail", "operation": "count", "filters": {}})
        # A join into another project's dataset is rejected too.
        assert not validate_query({"collection": "t_insurance", "operation": "aggregate", "pipeline": [
            {"$lookup": {"from": "t_retail", "localField": "country", "foreignField": "country", "as": "x"}}]})


def test_switching_a_project_off_hides_it_everywhere(admin_client):
    a, b = _setup_two_projects(admin_client)
    assert admin_client.patch(f"/api/projects/{a}", json={"enabled": False}).json()["enabled"] is False
    _login(admin_client, MEMBER)
    names = {p["id"] for p in admin_client.get("/api/projects").json()["projects"]}
    assert a not in names and b in names
    assert "t_insurance" not in get_schema()
    assert admin_client.get(f"/api/opportunities?project={a}").status_code == 409
    assert admin_client.get(f"/api/dashboard?project={a}").status_code == 409
    response = admin_client.post("/api/chat", json={"project": a, "messages": [{"role": "user", "content": "hi"}]})
    assert response.status_code == 409
    # Without a project, the disabled datasets are still excluded.
    assert "t_insurance" not in admin_client.get("/api/dashboard").json()["scope"]
    assert get_schema(all_collections=True).get("t_insurance")  # the admin catalog still lists it


def test_members_only_projects(admin_client):
    a, b = _setup_two_projects(admin_client)
    admin_client.patch(f"/api/projects/{a}", json={"access": "members", "members": [MEMBER["username"]]})
    assert admin_client.patch(f"/api/projects/{a}", json={"members": ["ghost"]}).status_code == 400

    tester = users.find_one({"username": "tester"})
    member = users.find_one({"username": MEMBER["username"]})
    with pytest.raises(Exception) as denied:
        projects.allowed_collections(tester, a)
    assert getattr(denied.value, "status_code", None) == 404
    assert "t_insurance" not in projects.allowed_collections(tester)  # not even without a project
    assert "t_insurance" in projects.allowed_collections(member, a)

    _login(admin_client, {"username": "tester", "password": "correct-horse-battery"})
    assert a not in {p["id"] for p in admin_client.get("/api/projects").json()["projects"]}
    assert admin_client.get(f"/api/opportunities?project={a}").status_code == 404


# ---------------------------------------------------------------- chat isolation

def test_chat_in_a_project_cannot_query_another_projects_data(admin_client, monkeypatch):
    from dataclasses import replace

    from backend import langchain_agent

    a, b = _setup_two_projects(admin_client)
    monkeypatch.setattr(chat_service, "settings",
                        replace(chat_service.settings, jev_enabled=False, openrouter_api_key="test-key"))
    monkeypatch.setattr(langchain_agent, "is_database_question", lambda q: True)
    # The model tries to read the retail project's collection from inside the insurance project.
    monkeypatch.setattr(langchain_agent, "generate_database_query",
                        lambda q, repair=None: {"collection": "t_retail", "operation": "count", "filters": {}})
    message = {"id": "u1", "role": "user", "content": "How many shops are there?"}
    thread = admin_client.post("/api/threads/create", json={"messages": [message]}).json()["id"]
    body = {"threadId": thread, "project": a, "messages": [message]}
    with admin_client.stream("POST", "/api/chat", json=body) as response:
        events = sse_events(response)
    results = [json.loads(e["content"]) for e in events if e["type"] == "TOOL_CALL_RESULT"]
    assert any(r.get("ok") is False for r in results)
    text = "".join(e["delta"] for e in events if e["type"] == "TEXT_MESSAGE_CONTENT")
    assert "couldn" in text.lower()
    # The chat is filed under its project.
    assert db["chat_threads"].find_one({"_id": thread})["project"] == a
    assert admin_client.get(f"/api/projects/{a}/threads").json()["threads"][0]["id"] == thread


# ---------------------------------------------------------------- insights

def test_use_cases_cite_evidence_and_flag_missing_data(admin_client):
    a, _ = _setup_two_projects(admin_client)
    body = admin_client.get(f"/api/opportunities?project={a}").json()
    cases = {c["id"]: c for c in body["use_cases"]}
    payroll = cases["international_payroll"]
    assert payroll["status"] == "ready"
    names = {acc["name"] for acc in payroll["top"]}
    assert {"Acme Mutual", "Delta Cover"} <= names
    acme = next(acc for acc in payroll["top"] if acc["name"] == "Acme Mutual")
    assert acme["evidence"][0]["value"] == "Global"
    assert cases["contract_renewal"]["status"] == "needs_data"
    assert "contract end" in cases["contract_renewal"]["missing"]
    gap = cases["digital_gap"]
    assert gap["status"] == "ready" and "Beta Insure" in {acc["name"] for acc in gap["top"]}
    # Repeated rows are one account.
    assert body["datasets"][0]["accounts"] == 4


def test_contract_renewal_uses_real_dates_only(admin_client):
    soon = (date.today() + timedelta(days=45)).isoformat()
    later = (date.today() + timedelta(days=400)).isoformat()
    csv = (f"Company Name,Country,Contract End Date\nNear Co,USA,{soon}\nFar Co,USA,{later}\nNo Date Co,USA,\n").encode()
    p = admin_client.post("/api/projects", json={"name": "Renewals"}).json()["id"]
    assert admin_client.post("/api/catalog/upload", files=_file("contracts.csv", csv),
                             data={"name": "t_contracts", "project": p}).status_code == 201
    case = next(c for c in admin_client.get(f"/api/opportunities?project={p}").json()["use_cases"]
                if c["id"] == "contract_renewal")
    assert case["status"] == "ready" and case["accounts"] == 1
    assert case["top"][0]["name"] == "Near Co" and case["top"][0]["evidence"][0]["why"] == "Ends in 45 days"


def test_profile_match_funnel_never_assumes_missing_values(admin_client):
    a, _ = _setup_two_projects(admin_client)
    request = {"project": a, "profile": {"countries": ["United States"], "sizes": ["large", "enterprise"]}}
    body = admin_client.post("/api/opportunities/match", json=request).json()
    steps = {s["step"]: s["count"] for s in body["funnel"]}
    assert steps["Accounts in scope"] == 4 and steps["Location"] == 2
    for account in body["accounts"]:
        assert account["fit"]["location"] == "match"
        assert account["fit"]["size"] in {"match", "unknown"}
    # Growth is unknown for this data: asking for it with include_unknown=False removes everyone.
    strict = admin_client.post("/api/opportunities/match", json={
        "project": a, "include_unknown": False, "profile": {"growth": True}}).json()
    assert strict["total"] == 0 and any("growth" in note for note in strict["notes"])
    assert admin_client.post("/api/opportunities/match", json={
        "project": a, "profile": {"sizes": ["huge"]}}).status_code == 400


def test_dashboard_builds_charts_for_project_and_dataset(admin_client):
    a, _ = _setup_two_projects(admin_client)
    board = admin_client.get(f"/api/dashboard?project={a}").json()
    assert board["scope"] == ["T Insurance"]
    kinds = {c["kind"] for c in board["charts"]}
    assert {"map", "stacked", "coverage"} <= kinds
    assert admin_client.get(f"/api/dashboard?project={a}&collection=t_retail").status_code == 400


def test_opportunity_question_in_chat_is_grounded(admin_client, monkeypatch):
    from dataclasses import replace

    a, _ = _setup_two_projects(admin_client)
    monkeypatch.setattr(chat_service, "settings",
                        replace(chat_service.settings, jev_enabled=False, openrouter_api_key="test-key"))

    async def fake(messages, model=None, stage=""):
        assert "OPPORTUNITY FINDINGS" in messages[-1]["content"]
        yield 'root = Card([h])\nh = CardHeader("International payroll & EOR")\n'

    monkeypatch.setattr(chat_service, "stream_openui", fake)
    body = {"project": a, "messages": [{"role": "user", "content": "What opportunities can I find in this data?"}]}
    with admin_client.stream("POST", "/api/chat", json=body) as response:
        events = sse_events(response)
    tools = [e["toolCallName"] for e in events if e["type"] == "TOOL_CALL_START"]
    assert "next_best_actions" in tools
