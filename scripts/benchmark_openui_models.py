"""Compare OpenRouter models on OpenUI generation for real MongoDB results.

For each model and question: time to first token, total time, whether the
output passes the official OpenUI parser, and whether its numbers are
grounded in the data. Results go to logs/openui_model_benchmark.json.

    python -m scripts.benchmark_openui_models google/gemini-2.5-flash openai/gpt-4.1-mini
"""

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.database_tool import run_database_query  # noqa: E402
from backend.openui_engine import LineSanitizer, data_messages, grounding_issues, stream_openui  # noqa: E402
from backend.openui_validator import validate  # noqa: E402

CASES = [
    (
        "Compare the average annual HR technology spend by deployment type",
        {"collection": "span_companies", "operation": "aggregate", "filters": {}, "fields": [],
         "pipeline": [{"$group": {"_id": "$deployment_type", "avg_spend": {"$avg": "$annual_hr_tech_spend_usd"}}},
                      {"$sort": {"avg_spend": -1}}]},
    ),
    (
        "Show total revenue per month in 2024 from sales",
        {"collection": "sales_cleaned", "operation": "aggregate", "filters": {}, "fields": [],
         "pipeline": [{"$match": {"year": 2024}}, {"$group": {"_id": "$month", "revenue": {"$sum": "$Revenue"}}},
                      {"$sort": {"_id": 1}}]},
    ),
]


async def run(model, question, query):
    rows = run_database_query(query)
    sanitizer = LineSanitizer()
    started = time.perf_counter()
    first = None
    try:
        async for chunk in stream_openui(data_messages(question, query, rows), model, "benchmark"):
            first = first or time.perf_counter() - started
            sanitizer.feed(chunk)
        sanitizer.finish()
        error = None
    except Exception as exc:  # noqa: BLE001
        error = str(exc)[:200]
    total = time.perf_counter() - started
    verdict = validate(sanitizer.text) or {}
    return {
        "model": model,
        "question": question,
        "error": error,
        "first_token_s": round(first, 2) if first else None,
        "total_s": round(total, 2),
        "parser_ok": verdict.get("ok"),
        "parser_errors": len(verdict.get("errors", [])),
        "ungrounded": grounding_issues(sanitizer.text, rows, question),
        "chars": len(sanitizer.text),
    }


async def main(models):
    results = []
    for model in models:
        for question, query in CASES:
            result = await run(model, question, query)
            print(json.dumps(result))
            results.append(result)
    Path("logs").mkdir(exist_ok=True)
    Path("logs/openui_model_benchmark.json").write_text(json.dumps(results, indent=2), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:] or ["google/gemini-2.5-flash"]))
