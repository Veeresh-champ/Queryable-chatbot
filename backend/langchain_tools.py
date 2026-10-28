
import json

from langchain_core.tools import tool

from backend.validator import validate_query
from backend.database_tool import run_database_query


@tool
def query_mongodb(query: str) -> str:
    """
    Execute a validated MongoDB query.
    The query must be provided as JSON.
    """
    try:
        query_data = json.loads(query)
    except json.JSONDecodeError as error:
        print("[DEBUG] Invalid JSON query:", repr(error))
        return "invalid query format"

    print("[DEBUG] Query received by query_mongodb:")
    print(json.dumps(query_data, indent=2, default=str))

    # Diagnose validation failures without bypassing validation.
    try:
        is_valid = validate_query(query_data)
    except Exception as error:
        print("[DEBUG] Validator raised an exception:", repr(error))
        return "query validation failed"

    if not is_valid:
        print("[DEBUG] QUERY VALIDATION FAILED")
        print("[DEBUG] Collection:", query_data.get("collection"))
        print("[DEBUG] Operation:", query_data.get("operation"))
        print("[DEBUG] Filters:", query_data.get("filters"))
        print("[DEBUG] Fields:", query_data.get("fields"))

        return "query validation failed"

    try:
        result = run_database_query(query_data)
        print("[DEBUG] Database query executed successfully.")
        return json.dumps(result, default=str)
    except Exception as error:
        print("[DEBUG] Database execution failed:", repr(error))
        return "database execution failed"
