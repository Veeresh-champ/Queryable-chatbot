"""Questions across several datasets, visuals for every answer shape, lab deep dive, headlines."""

import pytest

from backend import dashboard, project_lab, projects
from backend.analytics import answer_analysis
from backend.db import db, invalidate_project_cache, project_scope
from backend.schema_discovery import clear_schema_cache
from backend.validator import validate_query

ADMIN = {"username": "x", "role": "admin"}


@pytest.fixture()
def two_sheets(mongo):
    db["t_ins"].insert_many([{"company_name": f"I{i}", "country": "USA" if i % 2 else "India", "agents": i * 10,
                              "online_quote": bool(i % 3)} for i in range(1, 13)])
    db["t_ret"].insert_many([{"company_name": f"R{i}", "country": "Canada", "stores": i} for i in range(1, 6)])
    projects.projects.insert_one({"_id": "t-two", "name": "Two sheets", "enabled": True, "access": "everyone",
                                  "members": [], "datasets": ["t_ins", "t_ret"]})
    invalidate_project_cache()
    clear_schema_cache()
    yield
    db["t_ins"].drop()
    db["t_ret"].drop()
    projects.projects.delete_one({"_id": "t-two"})
    invalidate_project_cache()
    clear_schema_cache()


def test_union_combines_datasets_only_inside_the_scope(two_sheets):
    query = {"collection": "t_ins", "operation": "aggregate",
             "pipeline": [{"$unionWith": {"coll": "t_ret", "pipeline": [{"$addFields": {"dataset": "Retail"}}]}},
                          {"$count": "companies"}]}
    with project_scope(projects.allowed_collections(ADMIN, "t-two")):
        assert validate_query(query)
        assert not validate_query({**query, "pipeline": [{"$unionWith": "span_companies"}]})
        assert not validate_query({**query, "pipeline": [{"$unionWith": {"coll": "t_ret", "pipeline": [{"$out": "x"}]}}]})
        rows = list(db["t_ins"].aggregate(query["pipeline"]))
        assert rows == [{"companies": 17}]
        visual = answer_analysis(query, rows)
    assert visual and visual["stats"][0]["value"] == 17
    assert "Combined across 2 datasets" in visual["insights"][0]["title"]


def test_single_row_and_renamed_group_answers_get_visuals(two_sheets):
    with project_scope(projects.allowed_collections(ADMIN, "t-two")):
        count = {"collection": "t_ins", "operation": "aggregate", "pipeline": [{"$match": {"country": "USA"}}, {"$count": "count"}]}
        visual = answer_analysis(count, [{"count": 6}])
        assert visual and any(c["title"].startswith("By ") or c["kind"] == "donut" for c in visual["charts"])
        overview = {"collection": "t_ins", "operation": "aggregate",
                    "pipeline": [{"$group": {"_id": None, "n": {"$sum": 1}, "avg": {"$avg": "$agents"}}}, {"$project": {"_id": 0}}]}
        visual = answer_analysis(overview, [{"n": 12, "avg": 65.0}])
        assert visual and visual["stats"][0]["value"] == 12
        grouped = {"collection": "t_ins", "operation": "aggregate",
                   "pipeline": [{"$group": {"_id": "$country", "n": {"$sum": 1}}}, {"$project": {"_id": 0, "country": "$_id", "n": 1}}]}
        visual = answer_analysis(grouped, [{"country": "USA", "n": 6}, {"country": "India", "n": 6}])
        assert visual and visual["charts"]


def test_dataset_lab_and_headlines(two_sheets):
    with project_scope(projects.allowed_collections(ADMIN, "t-two")):
        lab = project_lab.dataset_lab("t_ins")
        assert lab["available"] and lab["swarm"] and lab["sunburst"]["outer"] == "Country"
        assert lab["outcome"]["field"] == "Online quote" and 0 < lab["outcome"]["overall"] < 1
        with pytest.raises(ValueError):
            project_lab.dataset_lab("span_companies")  # outside this project's scope
        board = dashboard.build("t_ins")
    assert board["charts"] and all("headline" in c for c in board["charts"])
    assert any(c["headline"] for c in board["charts"])
