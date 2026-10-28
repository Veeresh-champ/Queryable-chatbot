"""Thumbs up / down feedback on assistant answers.

    PUT    /api/feedback                          rate an answer (replaces an earlier rating)
    DELETE /api/feedback/{thread_id}/{message_id} take the rating back
    GET    /api/feedback/thread/{thread_id}       ratings in one conversation (to show the buttons' state)
    GET    /api/feedback/summary                  admin: totals, rate per route, recent thumbs-down

A rating stores what is needed to find out why an answer was wrong without
reading the whole conversation: the question, the MongoDB query that ran,
an excerpt of the answer and the request trace id (``logs/requests.jsonl``).
Thumbs-down answers are the raw material for new Golden Set cases.
"""

import json
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.auth import require_user
from backend.db import db
from backend.observability import logger
from backend.threads import get_owned, message_text

feedback = db["app_feedback"]

router = APIRouter(prefix="/api/feedback", tags=["feedback"])

# Must match REASONS in openui_test/src/components/assistant-message.tsx.
REASONS = {
    "wrong_numbers": "Wrong numbers",
    "off_topic": "Didn't answer my question",
    "incomplete": "Missing information",
    "hard_to_read": "Hard to read",
    "slow": "Too slow",
    "other": "Other",
}
MAX_COMMENT_CHARS = 1000
ANSWER_EXCERPT_CHARS = 4000
RECENT_LIMIT = 50


def ensure_indexes():
    feedback.create_index([("username", 1), ("message_id", 1)], unique=True)
    feedback.create_index([("rating", 1), ("updated_at", -1)])
    feedback.create_index([("thread_id", 1)])


class Rating(BaseModel):
    threadId: str = Field(min_length=1, max_length=64)
    messageId: str = Field(min_length=1, max_length=64)
    rating: Literal["up", "down"]
    reasons: list[str] = Field(default_factory=list, max_length=len(REASONS))
    comment: str = Field(default="", max_length=MAX_COMMENT_CHARS)


def _not_found():
    return HTTPException(status_code=404, detail={"code": "not_found", "message": "Answer not found."})


def answer_context(thread, message_id):
    """Question, MongoDB query and answer excerpt for one assistant message."""

    messages = thread.get("messages") or []
    index = next(
        (i for i, m in enumerate(messages) if m.get("id") == message_id and m.get("role") == "assistant"),
        None,
    )
    if index is None:
        return None

    question, query = "", None
    for earlier in reversed(messages[:index]):
        if earlier.get("role") == "user":
            question = message_text(earlier)
            break
        for call in earlier.get("toolCalls") or []:
            function = call.get("function") or {}
            if query is None and function.get("name") == "query_mongodb":
                try:
                    query = json.loads(function.get("arguments") or "null")
                except ValueError:
                    query = None

    meta = (thread.get("meta") or {}).get(message_id) or {}
    return {
        "question": question[:2000],
        "query": query,
        "answer_excerpt": message_text(messages[index])[:ANSWER_EXCERPT_CHARS],
        "trace_id": meta.get("trace_id"),
        "route": meta.get("route"),
        "status": meta.get("status"),
        "model": meta.get("model"),
    }


def _public(doc):
    return {"rating": doc["rating"], "reasons": doc.get("reasons", []), "comment": doc.get("comment", "")}


@router.put("")
def rate(payload: Rating, user=Depends(require_user)):
    unknown = set(payload.reasons) - set(REASONS)
    if unknown:
        raise HTTPException(status_code=400, detail={"code": "bad_reason", "message": "Unknown feedback reason."})

    thread = get_owned(payload.threadId, user["username"])
    context = answer_context(thread, payload.messageId)
    if context is None:
        raise _not_found()

    # Reasons and comments explain a thumbs-down; a thumbs-up clears them.
    down = payload.rating == "down"
    now = datetime.now(timezone.utc)
    doc = {
        "username": user["username"],
        "thread_id": payload.threadId,
        "message_id": payload.messageId,
        "rating": payload.rating,
        "reasons": sorted(set(payload.reasons)) if down else [],
        "comment": " ".join(payload.comment.split()) if down else "",
        "updated_at": now,
        **context,
    }
    feedback.update_one(
        {"username": user["username"], "message_id": payload.messageId},
        {"$set": doc, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )
    logger.info(
        "feedback rating=%s route=%s trace=%s reasons=%s",
        doc["rating"], doc["route"], doc["trace_id"], ",".join(doc["reasons"]) or "-",
    )
    return _public(doc)


@router.delete("/{thread_id}/{message_id}")
def clear(thread_id: str, message_id: str, user=Depends(require_user)):
    get_owned(thread_id, user["username"])
    feedback.delete_one({"username": user["username"], "thread_id": thread_id, "message_id": message_id})
    return {"ok": True}


@router.get("/thread/{thread_id}")
def thread_ratings(thread_id: str, user=Depends(require_user)):
    get_owned(thread_id, user["username"])
    docs = feedback.find({"username": user["username"], "thread_id": thread_id})
    return {"ratings": {doc["message_id"]: _public(doc) for doc in docs}}


@router.get("/summary")
def summary(user=Depends(require_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Administrators only."})

    totals = {row["_id"]: row["count"] for row in feedback.aggregate(
        [{"$group": {"_id": "$rating", "count": {"$sum": 1}}}]
    )}
    by_route = [
        {"route": row["_id"] or "unknown", "up": row["up"], "down": row["down"]}
        for row in feedback.aggregate([
            {"$group": {
                "_id": "$route",
                "up": {"$sum": {"$cond": [{"$eq": ["$rating", "up"]}, 1, 0]}},
                "down": {"$sum": {"$cond": [{"$eq": ["$rating", "down"]}, 1, 0]}},
            }},
            {"$sort": {"down": -1}},
        ])
    ]
    reason_counts = {row["_id"]: row["count"] for row in feedback.aggregate([
        {"$match": {"rating": "down"}},
        {"$unwind": "$reasons"},
        {"$group": {"_id": "$reasons", "count": {"$sum": 1}}},
    ])}
    recent = [
        {
            "at": doc["updated_at"].isoformat(),
            "username": doc["username"],
            "question": doc.get("question", ""),
            "reasons": doc.get("reasons", []),
            "comment": doc.get("comment", ""),
            "route": doc.get("route"),
            "query": doc.get("query"),
            "trace_id": doc.get("trace_id"),
        }
        for doc in feedback.find({"rating": "down"}).sort("updated_at", -1).limit(RECENT_LIMIT)
    ]
    up, down = totals.get("up", 0), totals.get("down", 0)
    return {
        "up": up,
        "down": down,
        "satisfaction": round(up / (up + down), 3) if up + down else None,
        "by_route": by_route,
        "reasons": {REASONS[key]: count for key, count in reason_counts.items() if key in REASONS},
        "recent_down": recent,
    }
