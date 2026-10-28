"""Live probe: log in, ask questions through /api/chat and validate the
OpenUI Lang the backend streams.

Requires MongoDB, OPENROUTER_API_KEY and the frontend node_modules (for the
official parser). Creates and removes a temporary user.

    python -m scripts.live_chat_probe "question one" "question two"

Writes each answer to logs/probe_<n>.openui.txt and prints a JSON summary.
"""

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

import backend.main as main  # noqa: E402
from backend.auth import create_user, users  # noqa: E402
from backend.openui_validator import validate  # noqa: E402
from backend.threads import threads  # noqa: E402

USER, PASSWORD = "probe_tmp", "probe-pass-12345"
DEFAULT_QUESTIONS = [
    "Which deployment type has the highest average annual HR technology spend?",
    "Show total annual HR tech spend by country for the top 5 countries",
    "What is the difference between SaaS and on-premise software?",
]


def ask(client, question):
    message = {"id": f"u{time.time_ns()}", "role": "user", "content": question}
    thread = client.post("/api/threads/create", json={"messages": [message]}).json()
    started = time.perf_counter()
    events, text, tools = [], "", []
    with client.stream(
        "POST",
        "/api/chat",
        json={"threadId": thread["id"], "runId": "probe", "messages": [message], "tools": [], "context": []},
    ) as response:
        status = response.status_code
        for line in response.iter_lines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            events.append(event["type"])
            if event["type"] == "TEXT_MESSAGE_CONTENT":
                text += event["delta"]
            if event["type"] == "TOOL_CALL_RESULT":
                tools.append(json.loads(event["content"]))
    return {
        "question": question,
        "status": status,
        "latency_s": round(time.perf_counter() - started, 2),
        "events": events,
        "tool_results": tools,
        "openui": text,
        "thread_id": thread["id"],
    }


def main_probe(questions):
    users.delete_many({"username": USER})
    create_user(USER, PASSWORD)
    client = TestClient(main.app)
    try:
        assert client.post("/api/auth/login", json={"username": USER, "password": PASSWORD}).status_code == 200
        out_dir = Path("logs")
        out_dir.mkdir(exist_ok=True)
        summary = []
        for index, question in enumerate(questions, 1):
            result = ask(client, question)
            (out_dir / f"probe_{index}.openui.txt").write_text(result["openui"], encoding="utf-8")
            verdict = validate(result["openui"])
            summary.append(
                {
                    "question": question,
                    "http_status": result["status"],
                    "latency_s": result["latency_s"],
                    "route": (result["tool_results"][0] if result["tool_results"] else {}).get("route"),
                    "query_ok": (result["tool_results"][1].get("ok") if len(result["tool_results"]) > 1 else None),
                    "event_types": sorted(set(result["events"])),
                    "parser_ok": verdict and verdict["ok"],
                    "parser_errors": verdict and verdict["errors"],
                    "fallback_root_appended": result["openui"].count("root = Card(") > 1,
                    "chars": len(result["openui"]),
                }
            )
        print(json.dumps({"results": summary, "metrics": main.metrics_snapshot()}, indent=2))
    finally:
        threads.delete_many({"username": USER})
        users.delete_many({"username": USER})


if __name__ == "__main__":
    main_probe(sys.argv[1:] or DEFAULT_QUESTIONS)
