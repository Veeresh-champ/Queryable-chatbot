
from backend.config import settings
from backend.db import db
from backend.guardrails import redact_pii

# Every query is read-only, time-limited and size-limited. The query
# validator runs before this module is called; these limits are a second
# line of defence against slow or very large reads.
MAX_TIME_MS = settings.mongo_max_time_ms
MAX_ROWS = settings.max_result_rows


def _collect(cursor):
    data = []

    for document in cursor:
        data.append(document)

        if len(data) >= MAX_ROWS:
            break

    return data


def run_database_query(query):
    collection_name = query["collection"]
    operation = query.get("operation", "find")
    filters = query.get("filters", {})
    fields = query.get("fields", [])
    pipeline = query.get("pipeline", [])
    field = query.get("field")

    collection = db[collection_name]

    if operation == "find":
        projection = {"_id": 0}
        for item in fields:
            projection[item] = 1

        results = collection.find(
            filters,
            projection,
            limit=MAX_ROWS,
            max_time_ms=MAX_TIME_MS,
        )

        return redact_pii(_collect(results))

    if operation == "count":
        count = collection.count_documents(filters, maxTimeMS=MAX_TIME_MS)
        return [{"count": count}]

    if operation == "distinct":
        if not field:
            return {"error": "field is required for distinct operation"}

        values = collection.distinct(field, filters, maxTimeMS=MAX_TIME_MS)
        return redact_pii([{"value": value} for value in values[:MAX_ROWS]])

    if operation == "aggregate":
        results = collection.aggregate(pipeline, maxTimeMS=MAX_TIME_MS)

        # Preserve _id because it may contain a group label.
        return redact_pii(_collect(results))

    return {"error": "unsupported operation"}
