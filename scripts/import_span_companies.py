import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.db import db  # noqa: E402  (uses MONGODB_URI / MONGODB_DB from .env)

ROOT = Path(__file__).resolve().parent.parent

# read the complete csv file
df = pd.read_csv(ROOT / "data" / "span_companies.csv")

# select the collection
collection = db["span_companies"]

# convert all rows into mongodb documents
records = df.to_dict("records")

# replace the collection, so running the import again does not duplicate rows
collection.delete_many({})
result = collection.insert_many(records)

# verify the data
print("records inserted:", len(result.inserted_ids))
print("records in span_companies:", collection.count_documents({}))
