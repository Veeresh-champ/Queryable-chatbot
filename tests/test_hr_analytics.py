"""IBM HR attrition dataset: separate dashboard and Analytics lab payloads."""

from pathlib import Path

import pandas as pd
import pytest

CSV = Path(__file__).resolve().parent.parent / "data" / "ibm_hr" / "WA_Fn-UseC_-HR-Employee-Attrition.csv"


@pytest.fixture()
def ibm_hr(mongo):
    """The real Kaggle CSV loaded into the test database, removed afterwards."""

    from backend import analytics, hr_analytics
    from backend.schema_discovery import clear_schema_cache

    records = [{k: (v.item() if hasattr(v, "item") else v) for k, v in row.items()}
               for row in pd.read_csv(CSV, encoding="utf-8-sig").to_dict("records")]
    mongo[hr_analytics.COLLECTION].insert_many(records)
    hr_analytics.clear_cache()
    analytics._LAB_CACHE["value"] = None
    clear_schema_cache()
    yield mongo[hr_analytics.COLLECTION]
    mongo.drop_collection(hr_analytics.COLLECTION)
    hr_analytics.clear_cache()
    analytics._LAB_CACHE["value"] = None
    clear_schema_cache()


def test_lab_numbers_match_the_dataset(ibm_hr, logged_in):
    body = logged_in.get("/api/analytics/lab?dataset=ibm_hr").json()
    assert body["dataset"] == "ibm_hr"
    kpis = {k["id"]: k["value"] for k in body["kpis"]}
    assert kpis["headcount"] == 1470
    assert kpis["attrition"] == pytest.approx(237 / 1470)
    for key in ("breakdowns", "drivers", "distributions", "tenure", "heatmaps", "pay_gap", "profiles", "scatter", "briefing"):
        assert body[key]
    overtime = {r["label"]: r for r in body["breakdowns"]["OverTime"]["rows"]}
    assert overtime["Yes"]["left"] + overtime["No"]["left"] == 237
    assert body["drivers"]["attrition"][0]["factor"] == "Overtime"
    assert len(body["scatter"]) == 1470
    # Every insight points at a card that exists on the page.
    views = {"breakdown", "drivers", "profiles", "distribution", "pay", "tenure", "scatter", "heatmap"}
    assert {i["view"] for i in body["insights"]} <= views


def test_overview_is_separate_from_the_default_dashboard(ibm_hr, logged_in):
    hr = logged_in.get("/api/insights/overview?dataset=ibm_hr").json()
    assert hr["kpis"][0]["value"] == 1470
    assert {p["id"] for p in hr["panels"]} >= {"dept_rate", "role_rate", "tenure_rate"}
    assert hr["maps"] == []

    default = logged_in.get("/api/insights/overview").json()
    labels = " ".join(k["label"].lower() for k in default["kpis"])
    assert "ibm" not in labels
    assert all(not p["id"].startswith(("dept_", "role_")) for p in default["panels"])

    span_lab = logged_in.get("/api/analytics/lab").json()
    assert "flow" in span_lab and "breakdowns" not in span_lab


def test_datasets_lists_ibm_hr_only_when_loaded(logged_in, mongo):
    ids = [d["id"] for d in logged_in.get("/api/datasets").json()["datasets"]]
    assert ids == ["span"]


def test_datasets_lists_both_when_loaded(ibm_hr, logged_in):
    ids = [d["id"] for d in logged_in.get("/api/datasets").json()["datasets"]]
    assert ids == ["span", "ibm_hr"]


def test_unknown_dataset_is_rejected(logged_in):
    assert logged_in.get("/api/analytics/lab?dataset=nope").status_code == 400
    assert logged_in.get("/api/insights/overview?dataset=nope").status_code == 400


def test_empty_collection_returns_empty_payload(logged_in, mongo):
    from backend import hr_analytics

    hr_analytics.clear_cache()
    body = logged_in.get("/api/analytics/lab?dataset=ibm_hr").json()
    assert body["kpis"] == [] and body["insights"] == []


def test_dataset_endpoints_require_login(app_client):
    assert app_client.get("/api/datasets").status_code == 401
    assert app_client.get("/api/analytics/lab?dataset=ibm_hr").status_code == 401
