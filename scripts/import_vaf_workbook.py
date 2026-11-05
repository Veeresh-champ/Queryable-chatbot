"""Import the VAF samples workbook (or any multi-sheet workbook) into a project.

Each sheet is one industry and becomes one dataset inside the project, tagged
with its industry, through the same validated path as the Data catalog upload
(staging collection, data-quality report, audit log entry).

Usage (from the project root, virtual environment active, local MongoDB):

    python -m scripts.import_vaf_workbook "path/to/VAF samples.xlsx"
    python -m scripts.import_vaf_workbook file.xlsx --sheet "2_Insurance"          # one industry only
    python -m scripts.import_vaf_workbook file.xlsx --dry-run                       # quality report only

--dry-run prints the data-quality report without writing anything. Re-running
replaces the sheets' datasets. Remove them from the Data catalog (Delete) or
with --remove.
"""

import argparse
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import projects as project_store  # noqa: E402
from backend.data_catalog import _sheet_words, datasets, import_file, parse_upload, suggested_name  # noqa: E402
from backend.db import db, invalidate_project_cache  # noqa: E402

ACTOR = {"username": "import-script"}
PROJECT_NAME = "VAF samples"
PROJECT_ID = "vaf-samples"
DESCRIPTION = ("Sample value-added fields (VAFs): one dataset per industry sheet "
               "(fast-growth, insurance, retail, HR/PEO, banking, home services).")


def ensure_project(name, project_id):
    if project_store.projects.find_one({"_id": project_id}):
        return project_id
    now = datetime.now(timezone.utc)
    project_store.projects.insert_one({
        "_id": project_id, "name": name, "description": DESCRIPTION, "category": "Market intelligence",
        "tags": ["vaf", "companies"], "enabled": True, "access": "everyone", "members": [],
        "datasets": [], "created_by": ACTOR["username"], "created_at": now, "updated_at": now,
    })
    invalidate_project_cache()
    print(f"Created project '{name}' ({project_id}).")
    return project_id


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("path")
    parser.add_argument("--sheet", action="append", help="import only this sheet (repeatable)")
    parser.add_argument("--project", default=PROJECT_NAME, help="project name")
    parser.add_argument("--project-id", default=PROJECT_ID)
    parser.add_argument("--dry-run", action="store_true", help="report data quality, write nothing")
    parser.add_argument("--remove", action="store_true", help="delete the datasets this workbook created")
    args = parser.parse_args()

    path = Path(args.path)
    content = path.read_bytes()
    filename = path.name
    sheets = parse_upload(filename, content)["sheets"]
    chosen = args.sheet or sheets
    missing = [s for s in chosen if s not in sheets]
    if missing:
        sys.exit(f"Unknown sheet(s): {missing}. Sheets: {sheets}")

    if args.remove:
        for sheet in chosen:
            name = suggested_name(filename, sheet, sheets)
            if datasets.find_one({"name": name}):
                db[name].drop()
                datasets.delete_one({"name": name})
                project_store.projects.update_many({}, {"$pull": {"datasets": name}})
                project_store.catalog_meta.delete_one({"_id": name})
                print(f"Removed {name}.")
        invalidate_project_cache()
        return

    project_id = None if args.dry_run else ensure_project(args.project, args.project_id)
    for sheet in chosen:
        parsed = parse_upload(filename, content, sheet)
        quality = parsed["quality"]
        name = suggested_name(filename, sheet, sheets)
        industry = re.sub(r"^\s*\d+\s*[_.)-]\s*", "", sheet).replace(",", " &").strip()
        print(f"\n{sheet} -> {name}: {len(parsed['documents'])} rows, quality score {quality['score']}/100, "
              f"completeness {quality['completeness']:.0%}")
        for issue in quality["issues"]:
            print(f"  [{issue['level']}] {issue['message']}")
        if args.dry_run:
            continue
        mode = "replace" if datasets.find_one({"name": name}) else "create"
        result = import_file(filename, content, ACTOR, name=name, label=f"{industry} (VAF)",
                             description=f"VAF sample, sheet '{sheet}'.", sheet=sheet, mode=mode,
                             project=project_id, tags=f"vaf,{_sheet_words(sheet).replace('_', '-')}")
        print(f"  -> {result['rows_total']} rows stored in '{name}' ({mode}), project '{project_id}'.")


if __name__ == "__main__":
    main()
