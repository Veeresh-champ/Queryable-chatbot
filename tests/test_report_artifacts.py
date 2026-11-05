"""Claude-style report artifacts: one artifact per topic, a new version per follow-up."""

from backend import artifacts
from tests.test_chat_flow import GOOD_UI, QUERY, ask, mocks, streaming  # noqa: F401 - fixture import

from backend import chat_service, langchain_agent


def _ask_in(client, thread, text):
    message = {"id": f"u-{text}", "role": "user", "content": text}
    body = {"threadId": thread, "runId": "r", "messages": [message], "tools": [], "context": []}
    import json

    from tests.conftest import sse_events

    with client.stream("POST", "/api/chat", json=body) as response:
        events = sse_events(response)
    results = {}
    names = {e["toolCallId"]: e["toolCallName"] for e in events if e["type"] == "TOOL_CALL_START"}
    for e in events:
        if e["type"] == "TOOL_CALL_RESULT":
            results[names[e["toolCallId"]]] = json.loads(e["content"])
    order = [e["type"] for e in events]
    return results, order


def test_follow_ups_on_one_dataset_version_the_same_artifact(logged_in, mocks):  # noqa: F811
    mocks.setattr(chat_service, "stream_openui", streaming(GOOD_UI, GOOD_UI, GOOD_UI))
    thread = logged_in.post("/api/threads/create", json={"messages": []}).json()["id"]

    first, order = _ask_in(logged_in, thread, "Average spend by deployment type")
    report = first["answer_artifact"]
    assert report["version"] == 1 and report["artifact_id"] == f"{thread}:span_companies"
    assert report["topic"] == "Span Companies" and report["table"]["rows"]
    assert {c["key"] for c in report["table"]["columns"]} >= {"_id", "avg"}
    # The artifact card comes after the answer text, as in Claude.
    last_text_end = max(i for i, t in enumerate(order) if t == "TEXT_MESSAGE_END")
    assert order.index("TOOL_CALL_START", last_text_end) > last_text_end

    second, _ = _ask_in(logged_in, thread, "Now sort it the other way")
    assert second["answer_artifact"]["artifact_id"] == report["artifact_id"]
    assert second["answer_artifact"]["version"] == 2
    assert second["answer_artifact"]["history"][0]["version"] == 1

    library = list(artifacts.artifacts.find({"type": "qc_report", "threadId": thread}))
    assert len(library) == 1
    stored = library[0]["content"]
    assert [v["version"] for v in stored["versions"]] == [1, 2] and library[0]["title"].endswith("v2")

    listed = logged_in.get("/api/artifacts?type=qc_report").json()["artifacts"]
    assert any(a["id"] == library[0]["_id"] for a in listed)
    opened = logged_in.get(f"/api/artifacts/{library[0]['_id']}").json()
    assert opened["content"]["version"] == 2 and len(opened["content"]["versions"]) == 2


def test_a_different_dataset_starts_a_new_artifact(logged_in, mocks, mongo):  # noqa: F811
    mongo["regions_tmp"].insert_many([{"region": "North", "sales": 10}, {"region": "South", "sales": 7}])
    from backend.schema_discovery import clear_schema_cache

    clear_schema_cache()
    try:
        mocks.setattr(chat_service, "stream_openui", streaming(*[GOOD_UI] * 6))
        thread = logged_in.post("/api/threads/create", json={"messages": []}).json()["id"]
        first, _ = _ask_in(logged_in, thread, "Average spend by deployment type")
        mocks.setattr(langchain_agent, "generate_database_query",
                      lambda q, repair=None: {"collection": "regions_tmp", "operation": "find", "filters": {}, "fields": ["region", "sales"]})
        second, _ = _ask_in(logged_in, thread, "Show sales by region")
        assert second["answer_artifact"]["artifact_id"] != first["answer_artifact"]["artifact_id"]
        assert second["answer_artifact"]["version"] == 1
        assert artifacts.artifacts.count_documents({"type": "qc_report", "threadId": thread}) == 2
    finally:
        mongo["regions_tmp"].drop()
        clear_schema_cache()
