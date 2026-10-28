"""Analytics lab: statistics helpers and the /api/analytics/lab payload."""

import pytest

from backend.analytics import _fit, _gini, _pareto, _pearson


def test_pearson_and_fit_on_a_perfect_line():
    xs, ys = [1, 2, 3, 4], [3, 5, 7, 9]
    assert _pearson(xs, ys) == pytest.approx(1.0)
    assert _fit(xs, ys) == pytest.approx((2.0, 1.0))


def test_gini_is_zero_when_even_and_high_when_concentrated():
    assert _gini([5, 5, 5, 5]) == pytest.approx(0.0)
    assert _gini([0, 0, 0, 100]) == pytest.approx(0.75)


def test_pareto_finds_the_eighty_percent_point():
    rows = [{"spend": v} for v in [80, 10, 5, 5]]
    result = _pareto(rows)
    assert result["companies_for_80"] == 1
    assert result["share_for_80"] == 0.25
    assert result["curve"][-1]["y"] == 1


def test_lab_endpoint_returns_every_view(logged_in):
    response = logged_in.get("/api/analytics/lab")
    assert response.status_code == 200
    body = response.json()
    for key in ("kpis", "flow", "network", "chord", "heatmap", "scatter", "pareto", "outliers", "segments", "drivers", "briefing", "insights"):
        assert key in body
    assert body["kpis"][0]["value"] == 9000.0
    assert len(body["scatter"]["points"]) == 3
    # Missing labels are grouped as "Unknown" instead of failing.
    assert {p["industry"] for p in body["scatter"]["points"]} == {"Unknown"}
    links = {(link["source"], link["target"]) for link in body["flow"]["links"]}
    assert ("c:India", "i:Unknown") in links


def test_lab_requires_login(app_client):
    assert app_client.get("/api/analytics/lab").status_code == 401


def test_count_answer_gets_share_and_spend_context(mongo):
    from backend.analytics import answer_analysis

    query = {"collection": "span_companies", "operation": "count", "filters": {"country": "India"}}
    result = answer_analysis(query, [{"count": 2}])
    stats = {s["label"]: s["value"] for s in result["stats"]}
    assert stats["Matching records"] == 2
    assert stats["Share of all records"] == pytest.approx(2 / 3)
    assert stats["Total annual hr tech spend (USD)"] == 4000.0
    assert result["charts"][0]["rows"] == [{"label": "Matching", "value": 2}, {"label": "Everything else", "value": 1}]
    assert result["insights"][0]["title"] == "2 of 3 records match"


def test_grouped_answer_is_named_after_the_measure(mongo):
    from backend.analytics import answer_analysis

    query = {"collection": "span_companies", "operation": "aggregate", "pipeline": [
        {"$group": {"_id": "$country", "total": {"$sum": "$annual_hr_tech_spend_usd"}}}]}
    rows = [{"_id": "India", "total": 4000.0}, {"_id": "United States", "total": 5000.0}]
    result = answer_analysis(query, rows)
    assert result["title"] == "Total annual hr tech spend (USD) by country"
    assert [c["kind"] for c in result["charts"]] == ["bars", "donut"]
    assert result["charts"][0]["format"] == "currency"


def test_monthly_answer_gets_a_forecast(mongo):
    from backend.analytics import answer_analysis

    query = {"collection": "sales_cleaned", "operation": "aggregate", "pipeline": []}
    rows = [{"_id": {"year": 2024, "month": m}, "revenue": 100.0 * m} for m in range(1, 7)]
    trend = answer_analysis(query, rows)["charts"][0]
    assert trend["kind"] == "trend"
    assert [p["label"] for p in trend["forecast"]] == ["2024-07", "2024-08", "2024-09"]
    assert trend["forecast"][0]["value"] == pytest.approx(700.0)


def test_single_record_is_compared_with_the_average(mongo):
    from backend.analytics import answer_analysis

    query = {"collection": "span_companies", "operation": "find", "filters": {"company_id": "S3"}}
    doc = {"company_name": "Gamma", "country": "United States", "annual_hr_tech_spend_usd": 5000.0, "employee_count": 900}
    result = answer_analysis(query, [doc])
    compare = result["charts"][0]
    assert compare["kind"] == "compare"
    assert compare["rows"][0]["baseline"] == pytest.approx(3000.0)


def test_empty_or_unknown_results_get_no_analysis():
    from backend.analytics import answer_analysis

    assert answer_analysis({"collection": "span_companies", "operation": "find"}, []) is None
    assert answer_analysis(None, [{"a": 1}]) is None


def test_kmeans_separates_obvious_groups():
    from backend.analytics import _kmeans

    vectors = [[0, 0], [0.1, 0], [0, 0.1], [10, 10], [10.1, 10], [10, 10.1]]
    labels, _ = _kmeans(vectors, 2)
    assert labels[0] == labels[1] == labels[2]
    assert labels[3] == labels[4] == labels[5]
    assert labels[0] != labels[3]


def test_eta_squared_measures_explained_variance():
    from backend.analytics import _eta_squared

    assert _eta_squared(["a", "a", "b", "b"], [1, 1, 5, 5]) == pytest.approx(1.0)
    assert _eta_squared(["a", "b", "a", "b"], [1, 1, 5, 5]) == pytest.approx(0.0)


def test_lab_has_segments_drivers_and_briefing(logged_in):
    from backend import analytics

    analytics._LAB_CACHE["value"] = None
    body = logged_in.get("/api/analytics/lab").json()
    assert body["segments"] and all(s["companies"] > 0 for s in body["segments"])
    assert {p["segment"] for p in body["scatter"]["points"]} <= {s["name"] for s in body["segments"]}
    assert {d["factor"] for d in body["drivers"]["spend"]} == {"Company size", "Industry", "Country", "HR tool", "Tech category", "Deployment"}
    assert body["briefing"].startswith("3 companies spend")
