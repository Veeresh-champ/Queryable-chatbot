
import time
import re
import json
from datetime import datetime

from backend.langchain_agent import run_langchain_agent


# Golden Set: expected facts verified against MongoDB
golden_set = [
    {
        "id": 1,
        "question": "How many companies are in India?",
        "expected": "38",
    },
    {
        "id": 2,
        "question": "How many companies are in the United States?",
        "expected": "176",
    },
    {
        "id": 3,
        "question": "How many companies are in the dataset?",
        "expected": "500",
    },
    {
        "id": 4,
        "question": "Which deployment type has the highest average annual HR technology spend?",
        "expected": "Hybrid",
    },
    {
        "id": 5,
        "question": "Which HR technology has the highest number of companies?",
        "expected": "iCIMS",
    },
    {
        "id": 6,
        "question": "Which deployment type has the lowest average annual HR technology spend?",
        "expected": "SaaS",
    },
    {
        "id": 7,
        "question": "Which country has the highest total annual HR technology spend?",
        "expected": "United States",
    },
    {
        "id": 8,
        "question": "Which technology category has the highest average annual HR technology spend?",
        "expected": "Global Employment",
    },
    {
        "id": 9,
        "question": "What is the average employee count across all companies?",
        "expected": None,
    },
    {
        "id": 10,
        "question": "List the available deployment types.",
        "expected": None,
    },
]

def check_answer(answer, expected):
    # Check expected numeric values as complete numbers,
    # avoiding accidental matches inside larger numbers.
    if expected.isdigit():
        return re.search(
            rf"(?<![\d.]){re.escape(expected)}(?![\d.])",
            answer
        ) is not None

    return expected.lower() in answer.lower()


def main():
    results = []
    passed = 0

    print("=" * 60)
    print("QUERYABLE CHATBOT - GOLDEN SET EVALUATION")
    print("=" * 60)

    for test in golden_set:
        print(f"\nTest {test['id']}: {test['question']}")

        start = time.perf_counter()

        try:
            answer = str(run_langchain_agent(test["question"]))
            latency = time.perf_counter() - start
            success = check_answer(answer, test["expected"])

            if success:
                passed += 1

            status = "PASS" if success else "REVIEW"

            print("Status:", status)
            print("Expected fact:", test["expected"])
            print("Latency:", round(latency, 2), "seconds")
            print("Answer:", answer[:500])

            results.append({
                "id": test["id"],
                "question": test["question"],
                "expected": test["expected"],
                "answer": answer,
                "status": status,
                "latency_seconds": round(latency, 3),
            })

        except Exception as error:
            latency = time.perf_counter() - start

            print("Status: ERROR")
            print("Error:", str(error))

            results.append({
                "id": test["id"],
                "question": test["question"],
                "expected": test["expected"],
                "status": "ERROR",
                "error": str(error),
                "latency_seconds": round(latency, 3),
            })

    total = len(golden_set)
    pass_rate = (passed / total * 100) if total else 0

    report = {
        "run_at": datetime.now().isoformat(timespec="seconds"),
        "total_tests": total,
        "passed": passed,
        "review_or_error": total - passed,
        "pass_rate_percent": round(pass_rate, 2),
        "results": results,
    }

    with open("evaluation_results.json", "w", encoding="utf-8") as file:
        json.dump(report, file, indent=2, ensure_ascii=False)

    print("\n" + "=" * 60)
    print(f"Tests: {total}")
    print(f"Passed: {passed}")
    print(f"Review or error: {total - passed}")
    print(f"Pass rate: {pass_rate:.2f}%")
    print("Report saved to evaluation_results.json")
    print("=" * 60)


if __name__ == "__main__":
    main()
