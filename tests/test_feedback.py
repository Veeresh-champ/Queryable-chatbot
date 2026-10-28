"""Thumbs up / down feedback on assistant answers."""

import json

import pytest

from backend import feedback, threads

QUERY = {"collection": "span_companies", "operation": "count", "filters": {"country": "India"}}


@pytest.fixture()
def answered_thread(logged_in):
    """A conversation with one database answer, as chat_service saves it."""

    feedback.ensure_indexes()
    feedback.feedback.delete_many({})
    thread = logged_in.post("/api/threads/create", json={"messages": []}).json()
    messages = [
        {"id": "u1", "role": "user", "content": "How many companies are in India?"},
        {"id": "t1", "role": "assistant", "content": "", "toolCalls": [
            {"id": "c1", "type": "function",
             "function": {"name": "query_mongodb", "arguments": json.dumps(QUERY)}},
        ]},
        {"id": "r1", "role": "tool", "toolCallId": "c1", "content": "{}"},
        {"id": "a1", "role": "assistant", "content": 'root = TextContent("There are 2 companies in India.")'},
    ]
    threads.save_messages(thread["id"], "tester", messages,
                          {"a1": {"trace_id": "trace-1", "route": "database_query", "status": "ok", "model": "m"}})
    yield logged_in, thread["id"]
    feedback.feedback.delete_many({})


def rate(client, thread_id, message_id="a1", **body):
    return client.put("/api/feedback", json={"threadId": thread_id, "messageId": message_id, **body})


def test_thumbs_down_stores_question_query_and_trace(answered_thread):
    client, thread_id = answered_thread
    response = rate(client, thread_id, rating="down", reasons=["wrong_numbers"], comment="  It is   3 ")
    assert response.status_code == 200
    assert response.json() == {"rating": "down", "reasons": ["wrong_numbers"], "comment": "It is 3"}

    doc = feedback.feedback.find_one({"message_id": "a1"})
    assert doc["question"] == "How many companies are in India?"
    assert doc["query"] == QUERY
    assert doc["trace_id"] == "trace-1"
    assert doc["route"] == "database_query"
    assert "2 companies" in doc["answer_excerpt"]


def test_rating_again_replaces_and_thumbs_up_clears_reasons(answered_thread):
    client, thread_id = answered_thread
    rate(client, thread_id, rating="down", reasons=["slow"], comment="meh")
    response = rate(client, thread_id, rating="up", reasons=["slow"], comment="ignored")
    assert response.json() == {"rating": "up", "reasons": [], "comment": ""}
    assert feedback.feedback.count_documents({"message_id": "a1"}) == 1

    ratings = client.get(f"/api/feedback/thread/{thread_id}").json()["ratings"]
    assert ratings == {"a1": {"rating": "up", "reasons": [], "comment": ""}}


def test_rating_can_be_taken_back(answered_thread):
    client, thread_id = answered_thread
    rate(client, thread_id, rating="up")
    assert client.delete(f"/api/feedback/{thread_id}/a1").status_code == 200
    assert client.get(f"/api/feedback/thread/{thread_id}").json()["ratings"] == {}


@pytest.mark.parametrize(
    "body,status",
    [
        ({"rating": "meh"}, 422),
        ({"rating": "down", "reasons": ["not_a_reason"]}, 400),
        ({"rating": "down", "comment": "x" * 1001}, 422),
    ],
)
def test_invalid_ratings_are_rejected(answered_thread, body, status):
    client, thread_id = answered_thread
    assert rate(client, thread_id, **body).status_code == status


def test_only_assistant_answers_in_own_threads_can_be_rated(answered_thread):
    client, thread_id = answered_thread
    assert rate(client, thread_id, message_id="u1", rating="up").status_code == 404
    assert rate(client, thread_id, message_id="missing", rating="up").status_code == 404
    assert rate(client, "someone-elses-thread", rating="up").status_code == 404


def test_feedback_collection_is_hidden_from_the_chatbot():
    from backend.config import INTERNAL_COLLECTIONS

    assert "app_feedback" in INTERNAL_COLLECTIONS


def test_summary_is_admin_only(answered_thread):
    client, thread_id = answered_thread
    rate(client, thread_id, rating="down", reasons=["wrong_numbers"])
    assert client.get("/api/feedback/summary").status_code == 403

    from backend.auth import users

    users.update_one({"username": "tester"}, {"$set": {"role": "admin"}})
    summary = client.get("/api/feedback/summary").json()
    assert summary["down"] == 1 and summary["up"] == 0 and summary["satisfaction"] == 0
    assert summary["reasons"] == {"Wrong numbers": 1}
    assert summary["by_route"] == [{"route": "database_query", "up": 0, "down": 1}]
    assert summary["recent_down"][0]["question"] == "How many companies are in India?"


def test_chat_saves_answer_meta_for_feedback(answered_thread):
    from backend.chat_service import ChatRun

    run = ChatRun({"username": "tester"}, None, [{"role": "user", "content": "hi"}])
    run.generated = [
        {"id": "tool", "role": "assistant", "content": "", "toolCalls": [{"id": "c"}]},
        {"id": "answer", "role": "assistant", "content": "root = Card([])"},
    ]
    assert list(run.answer_meta()) == ["answer"]
