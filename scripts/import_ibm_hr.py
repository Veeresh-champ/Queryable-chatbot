"""Import the IBM HR Analytics Employee Attrition dataset into MongoDB.

Source: Kaggle, pavansubhasht/ibm-hr-analytics-attrition-dataset
(WA_Fn-UseC_-HR-Employee-Attrition.csv, 1,470 employees x 35 columns).

The rows go into their own collection, ``ibm_hr_employees``, with the
original Kaggle column names, so the existing collections (span_companies,
the e-commerce tables, employees) are never touched. Running it again
replaces the collection instead of duplicating rows.

    .venv\\Scripts\\python.exe scripts\\import_ibm_hr.py
"""

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.db import db  # noqa: E402  (uses MONGODB_URI / MONGODB_DB from .env)
from backend.hr_analytics import COLLECTION  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CSV = ROOT / "data" / "ibm_hr" / "WA_Fn-UseC_-HR-Employee-Attrition.csv"

df = pd.read_csv(CSV, encoding="utf-8-sig")

# numpy ints/floats -> plain Python values that BSON can store
records = [{key: (value.item() if hasattr(value, "item") else value) for key, value in row.items()}
           for row in df.to_dict("records")]

collection = db[COLLECTION]
collection.delete_many({})
result = collection.insert_many(records)
collection.create_index("EmployeeNumber", unique=True)

print("records inserted:", len(result.inserted_ids))
print(f"records in {COLLECTION}:", collection.count_documents({}))
