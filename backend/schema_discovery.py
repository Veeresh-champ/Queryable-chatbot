
import copy
import threading
import time

from backend.db import business_collection_names, db

SAMPLE_LIMIT = 1000

# Schema discovery samples every collection, and one chat request needs the
# schema several times (routing, query generation, validation). A short cache
# keeps those calls consistent and avoids repeated collection scans.
SCHEMA_CACHE_SECONDS = 60

_cache = {"schema": None, "expires": 0.0}
_cache_lock = threading.Lock()


def get_schema():
    now = time.monotonic()

    with _cache_lock:
        if _cache["schema"] is not None and now < _cache["expires"]:
            return copy.deepcopy(_cache["schema"])

    schema = _discover_schema()

    with _cache_lock:
        _cache["schema"] = schema
        _cache["expires"] = time.monotonic() + SCHEMA_CACHE_SECONDS

    return copy.deepcopy(schema)


def clear_schema_cache():
    with _cache_lock:
        _cache["schema"] = None
        _cache["expires"] = 0.0


def _discover_schema():
    schema = {}

    for collection_name in business_collection_names():
        collection = db[collection_name]
        fields = {}

        documents = collection.find(
            {},
            {"_id": 0}
        ).limit(SAMPLE_LIMIT)

        for document in documents:
            for field, value in document.items():
                if field not in fields:
                    fields[field] = {
                        "type": type(value).__name__,
                        "sample_values": [],
                    }

                sample_values = fields[field]["sample_values"]
                value_text = str(value)

                if (
                    len(sample_values) < 3
                    and value_text not in [str(item) for item in sample_values]
                ):
                    sample_values.append(value)

        if fields:
            schema[collection_name] = fields

    return schema


if __name__ == "__main__":
    try:
        result = get_schema()

        for collection_name, fields in result.items():
            print(f"\nCollection: {collection_name}")
            for field, details in fields.items():
                print(
                    f"{field} -> {details['type']} "
                    f"| samples: {details['sample_values']}"
                )

    except Exception as error:
        print("Schema discovery failed:", error)
