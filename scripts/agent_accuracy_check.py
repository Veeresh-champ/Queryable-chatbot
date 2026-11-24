"""Accuracy check: does the agent's answer match the database?

Asks the live agent API questions whose true answer is computed here
directly with pymongo (no AI involved), then compares the numbers.

    $env:QC_API_KEY="qc-..."; python -m scripts.agent_accuracy_check
    (QC_API_URL defaults to http://127.0.0.1:8000; MONGODB_DB must match that backend)

Exit code 0 when every check passes, 1 otherwise.
"""

import os
import re
import sys

import httpx

from backend.db import db

API = os.getenv("QC_API_URL", "http://127.0.0.1:8000").rstrip("/")
KEY = os.getenv("QC_API_KEY", "")


def _numbers(text):
    return {round(float(n.replace(",", "")), 2) for n in re.findall(r"\d[\d,]*\.?\d*", text or "")}


def _rows_numbers(rows):
    out = set()
    for row in rows or []:
        for value in (row.values() if isinstance(row, dict) else [row]):
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                out.add(round(float(value), 2))
    return out


def _agg(collection, pipeline):
    return list(db[collection].aggregate(pipeline))


def checks():
    span, hr, bank = "span_companies", "ibm_hr_employees", "vaf_banking_financial"
    yield ("How many companies use Deel?",
           [db[span].count_documents({"hr_technology": "Deel"})])
    yield ("How many companies use Rippling?",
           [db[span].count_documents({"hr_technology": "Rippling"})])
    yield ("What is the average annual HR tech spend by deployment type?",
           [round(r["v"], 2) for r in _agg(span, [{"$group": {"_id": "$deployment_type",
                                                              "v": {"$avg": "$annual_hr_tech_spend_usd"}}}])])
    yield ("How many companies are there in total in span_companies?", [db[span].count_documents({})])
    yield ("How many employees in ibm_hr_employees have left the company (Attrition is Yes)?",
           [db[hr].count_documents({"Attrition": "Yes"})])
    yield ("What is the attrition rate in percent for each department in ibm_hr_employees?",
           [round(100 * r["left"] / r["n"], 2) for r in _agg(hr, [{"$group": {
               "_id": "$Department", "n": {"$sum": 1},
               "left": {"$sum": {"$cond": [{"$eq": ["$Attrition", "Yes"]}, 1, 0]}}}}])])
    yield ("How many companies in vaf_banking_financial have a license type of National Bank?",
           [db[bank].count_documents({"license_type": "National Bank"})])
    yield ("What is the highest annual HR tech spend of any company?",
           [round(r["v"], 2) for r in _agg(span, [{"$group": {"_id": None,
                                                              "v": {"$max": "$annual_hr_tech_spend_usd"}}}])])


def close(expected, found):
    return any(abs(expected - f) <= max(0.011, abs(expected) * 0.0005) for f in found)


def main():
    if not KEY:
        sys.exit("Set QC_API_KEY.")
    failures = 0
    with httpx.Client(base_url=API, timeout=180, headers={"Authorization": f"Bearer {KEY}",
                                                          "X-Agent-Name": "accuracy-check"}) as client:
        for question, expected in checks():
            body = client.post("/api/agent/ask", json={"question": question}).json()
            found = _numbers(body.get("answer")) | _rows_numbers(body.get("rows"))
            missing = [e for e in expected if not close(e, found)]
            ok = body.get("status") == "answered" and not missing
            failures += not ok
            print(f"{'PASS' if ok else 'FAIL'}  {question}")
            print(f"      expected {expected}  status={body.get('status')}"
                  + (f"  MISSING {missing}" if missing else ""))
            if not ok:
                print("      query:", body.get("query"))
                print("      answer:", (body.get("answer") or "")[:300].replace("\n", " "))
    print(f"\n{'ALL PASSED' if not failures else f'{failures} FAILED'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
