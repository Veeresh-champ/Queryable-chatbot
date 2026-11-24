"""A2A demo: a "personal agent" discovers our data agent and talks to it.

Shows the A2A flow end to end, no LLM needed on the caller side:

    1. GET  /.well-known/agent-card.json   discover who the agent is and its skills
    2. POST /a2a  message/send (skill ask)            plain-English question
    3. POST /a2a  message/send (skill match_profile)  structured ICP in a data part
    4. POST /a2a  tasks/get                           fetch a task again by id

Run (backend on :8000):

    $env:QC_API_KEY="qc-..."; python -m scripts.a2a_demo
    python -m scripts.a2a_demo --question "Which industries spend the most on HR tech?"
"""

import argparse
import json
import os
import sys
import uuid

import httpx

BASE = os.getenv("QC_API_URL", "http://127.0.0.1:8000").rstrip("/")
PERSONA = "Head of Sales at a payroll SaaS selling to large companies in India"


def send(client, parts, context_id):
    rpc = {"jsonrpc": "2.0", "id": uuid.uuid4().hex[:8], "method": "message/send",
           "params": {"message": {"role": "user", "kind": "message", "messageId": uuid.uuid4().hex,
                                  "contextId": context_id, "parts": parts}}}
    response = client.post("/a2a", json=rpc)
    body = response.json()
    if "error" in body:
        sys.exit(f"A2A error {body['error']['code']}: {body['error']['message']}")
    return body["result"]


def show(title, task):
    print(f"\n=== {title} ===")
    print(f"task {task['id'][:8]}  state={task['status']['state']}")
    print("agent says:", task["status"]["message"]["parts"][0]["text"][:800])
    for artifact in task.get("artifacts", []):
        data = next((p["data"] for p in artifact["parts"] if p.get("kind") == "data"), None)
        if isinstance(data, dict) and "query" in data:
            print("query ran:", json.dumps(data["query"])[:300])
            print(f"rows: {data['row_count']}  next: {data['suggested_next_questions'][:2]}")
        elif isinstance(data, dict) and "funnel" in data:
            print("funnel:", " -> ".join(f"{s['step']} {s['count']}" for s in data["funnel"]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--question", default="How many companies are there in each country?")
    args = parser.parse_args()
    key = os.getenv("QC_API_KEY")
    if not key:
        sys.exit("Set QC_API_KEY to a personal API key (Settings -> API keys).")

    headers = {"Authorization": f"Bearer {key}", "X-Agent-Name": "a2a-demo-agent", "X-Agent-Persona": PERSONA}
    with httpx.Client(base_url=BASE, headers=headers, timeout=180) as client:
        card = client.get("/.well-known/agent-card.json").json()
        print(f"Discovered: {card['name']} v{card['version']} at {card['url']}")
        for skill in card["skills"]:
            print(f"  skill {skill['id']}: {skill['name']}")

        context = uuid.uuid4().hex
        task = send(client, [{"kind": "text", "text": args.question}], context)
        show("skill: ask", task)

        task2 = send(client, [{"kind": "text", "text": "Large accounts in India for my payroll product"},
                              {"kind": "data", "data": {"skill": "match_profile", "limit": 5,
                                                        "profile": {"countries": ["India"], "sizes": ["large"]}}}],
                     context)
        show("skill: match_profile", task2)

        again = client.post("/a2a", json={"jsonrpc": "2.0", "id": "g", "method": "tasks/get",
                                          "params": {"id": task["id"]}}).json()
        print(f"\ntasks/get {task['id'][:8]} -> state={again['result']['status']['state']}")


if __name__ == "__main__":
    main()
