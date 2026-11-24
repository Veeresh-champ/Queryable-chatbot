"""Agent-to-agent API (/api/agent/*) and its query log."""

import pytest

from backend import agent_api, langchain_agent

QUERY = {"collection": "span_companies", "operation": "find", "filters": {"country": "India"},
         "fields": ["company_name"]}


@pytest.fixture()
def api_key(logged_in):
    from backend.account import api_keys

    api_keys.delete_many({"username": "tester"})
    response = logged_in.post("/api/account/keys", json={"name": "mcp"})
    assert response.status_code == 201, response.text
    body = response.json()
    return body.get("key") or body.get("token") or body.get("secret")


@pytest.fixture()
def fake_agent(monkeypatch):
    monkeypatch.setattr(langchain_agent, "is_database_question", lambda q: True)
    monkeypatch.setattr(langchain_agent, "generate_database_query", lambda q, repair_feedback=None: dict(QUERY))
    monkeypatch.setattr(langchain_agent, "format_database_result", lambda q, r: "Two companies: Alpha, Beta.")
    agent_api.LOG.delete_many({})


def test_manifest_is_public():
    from fastapi.testclient import TestClient

    import backend.main as main

    with TestClient(main.app) as client:
        body = client.get("/api/agent/manifest").json()
    assert {t["name"] for t in body["tools"]} >= {"ask_data", "match_profile", "list_datasets"}


def test_agent_endpoints_need_auth(app_client):
    assert app_client.post("/api/agent/ask", json={"question": "hi"}).status_code == 401


def test_ask_returns_structured_answer_and_logs_it(app_client, api_key, fake_agent):
    app_client.cookies.clear()
    headers = {"Authorization": f"Bearer {api_key}", "X-Agent-Name": "persona-bot", "X-Agent-Persona": "HR lead"}
    response = app_client.post("/api/agent/ask", json={"question": "Companies in India?"}, headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "answered"
    assert body["query"]["collection"] == "span_companies"
    assert body["row_count"] == 2
    assert {r["company_name"] for r in body["rows"]} == {"Alpha", "Beta"}
    assert body["intent"] == "lookup"
    assert body["suggested_next_questions"]

    entry = agent_api.LOG.find_one({"agent": "persona-bot"})
    assert entry["tool"] == "ask_data" and entry["status"] == "answered" and entry["persona"] == "HR lead"


def test_unanswerable_is_reported_as_a_data_gap(app_client, api_key, monkeypatch, fake_agent):
    monkeypatch.setattr(langchain_agent, "generate_database_query",
                        lambda q, repair_feedback=None: {"unanswerable": "license status"})
    app_client.cookies.clear()
    body = app_client.post("/api/agent/ask", json={"question": "Which fintechs are licensed?"},
                           headers={"Authorization": f"Bearer {api_key}"}).json()
    assert body["status"] == "unanswerable" and body["missing_field"] == "license status"


def test_datasets_lists_fields(app_client, api_key):
    app_client.cookies.clear()
    body = app_client.get("/api/agent/datasets", headers={"Authorization": f"Bearer {api_key}"}).json()
    span = next(d for d in body["datasets"] if d["name"] == "span_companies")
    assert "country" in span["fields"] and span["kind"] == "company / account records"

    detail = app_client.get("/api/agent/datasets", params={"dataset": "span_companies"},
                            headers={"Authorization": f"Bearer {api_key}"}).json()
    assert any(f["name"] == "country" and f["samples"] for f in detail["fields"])
    missing = app_client.get("/api/agent/datasets", params={"dataset": "nope"},
                             headers={"Authorization": f"Bearer {api_key}"})
    assert missing.status_code == 404


def test_admin_summary_requires_admin(logged_in):
    assert logged_in.get("/api/admin/agent-queries").status_code == 403


def test_summary_counts(mongo, fake_agent):
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    agent_api.LOG.insert_many([
        {"ts": now, "agent": "a", "tool": "ask_data", "status": "answered", "latency_ms": 100,
         "intent": "ranking", "input": {"question": "Which industries spend most on payroll?"}},
        {"ts": now, "agent": "b", "tool": "ask_data", "status": "unanswerable", "latency_ms": 300,
         "missing_field": "license status", "input": {"question": "Which fintechs are licensed?"}},
    ])
    summary = agent_api.query_summary()
    assert summary["total"] == 2 and summary["agents"] == 2 and summary["answered_rate"] == 0.5
    assert summary["data_gaps"][0]["key"] == "license status"


# --------------------------------------------------
# A2A (agent-to-agent protocol)
# --------------------------------------------------

def _send(client, key, parts, rpc_id=1):
    return client.post("/a2a", headers={"Authorization": f"Bearer {key}"}, json={
        "jsonrpc": "2.0", "id": rpc_id, "method": "message/send",
        "params": {"message": {"role": "user", "parts": parts}}})


def test_agent_card_is_public(app_client):
    card = app_client.get("/.well-known/agent-card.json").json()
    assert card["url"].endswith("/a2a")
    assert {s["id"] for s in card["skills"]} == {"ask", "find_opportunities", "match_profile"}


def test_a2a_requires_auth(app_client):
    app_client.cookies.clear()
    response = app_client.post("/a2a", json={"jsonrpc": "2.0", "id": 1, "method": "message/send",
                                             "params": {"message": {"role": "user", "parts": []}}})
    assert response.status_code == 401 and response.json()["error"]["code"] == -32001


def test_a2a_message_returns_completed_task_and_logs_channel(app_client, api_key, fake_agent):
    app_client.cookies.clear()
    body = _send(app_client, api_key, [{"kind": "text", "text": "Companies in India?"}]).json()
    task = body["result"]
    assert task["kind"] == "task" and task["status"]["state"] == "completed"
    data = task["artifacts"][0]["parts"][1]["data"]
    assert data["row_count"] == 2
    entry = agent_api.LOG.find_one({"tool": "a2a:ask"})
    assert entry["channel"] == "a2a"

    got = app_client.post("/a2a", headers={"Authorization": f"Bearer {api_key}"},
                          json={"jsonrpc": "2.0", "id": 2, "method": "tasks/get", "params": {"id": task["id"]}})
    assert got.json()["result"]["id"] == task["id"]


def test_a2a_match_profile_skill(app_client, api_key, fake_agent):
    app_client.cookies.clear()
    parts = [{"kind": "text", "text": "Accounts in India"},
             {"kind": "data", "data": {"skill": "match_profile", "profile": {"countries": ["India"]}}}]
    task = _send(app_client, api_key, parts).json()["result"]
    assert task["status"]["state"] == "completed"
    assert "funnel" in task["artifacts"][0]["parts"][1]["data"]


def test_a2a_unknown_method(app_client, api_key):
    app_client.cookies.clear()
    response = app_client.post("/a2a", headers={"Authorization": f"Bearer {api_key}"},
                               json={"jsonrpc": "2.0", "id": 9, "method": "nope"})
    assert response.json()["error"]["code"] == -32601


def test_mcp_header_marks_channel(app_client, api_key, fake_agent):
    app_client.cookies.clear()
    app_client.post("/api/agent/ask", json={"question": "Companies in India?"},
                    headers={"Authorization": f"Bearer {api_key}", "X-Agent-Channel": "mcp"})
    assert agent_api.LOG.find_one({"tool": "ask_data"})["channel"] == "mcp"


def test_internal_logs_are_never_datasets(mongo):
    from backend.db import business_collection_names, db

    db["security_log"].insert_one({"action": "login.success", "username": "x", "ip": "127.0.0.1"})
    db["agent_query_log"].insert_one({"tool": "ask_data"})
    names = business_collection_names(scoped=False)
    assert "security_log" not in names and "agent_query_log" not in names
