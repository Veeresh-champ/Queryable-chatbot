"""Local, non-destructive authorization probe for the security audit.

Runs the FastAPI app in-process (TestClient) against a throwaway database
`queryable_chatbot_audit` on the LOCAL MongoDB, with LLM keys blanked so no
external API is called. Dummy users/datasets only; the database is dropped at
the end. Usage: python authz_probe.py <repo_root> <log_dir>
"""
import io
import json
import os
import sys

ROOT, LOG_DIR = sys.argv[1], sys.argv[2]
os.environ.update({
    "MONGODB_URI": "mongodb://localhost:27017",
    "MONGODB_DB": "queryable_chatbot_audit",
    "OPENROUTER_API_KEY": "",
    "THESYS_API_KEY": "",
    "JEV_ENABLED": "false",
    "GRAPHITI_ENABLED": "false",
    "QUERYABLE_LOG_DIR": LOG_DIR,
    "LOGIN_MAX_ATTEMPTS": "5",
})
sys.path.insert(0, ROOT)

from fastapi.testclient import TestClient  # noqa: E402

from backend.db import client  # noqa: E402

DB = "queryable_chatbot_audit"
assert client[DB].name == DB
client.drop_database(DB)

import backend.main as main  # noqa: E402
from backend import auth, projects  # noqa: E402

results = []


def record(test_id, desc, status, expected_secure, body=None):
    secure = status in expected_secure
    results.append({"id": test_id, "test": desc, "status": status,
                    "expected_secure": sorted(expected_secure),
                    "result": "PASS (secure)" if secure else "FAIL (vulnerable)",
                    "detail": body})
    print(f"{test_id:6} {'OK  ' if secure else 'VULN'} HTTP {status:3}  {desc}")


def login(c, u, p):
    r = c.post("/api/auth/login", json={"username": u, "password": p})
    assert r.status_code == 200, r.text
    return c


with TestClient(main.app) as admin_c, TestClient(main.app) as analyst_c, TestClient(main.app) as anon:
    auth.create_user("audit_admin", "Adm1n-audit-pass", "Audit Admin", role="admin")
    auth.create_user("audit_analyst", "Analyst-audit-pass", "Audit Analyst", role="analyst")
    login(admin_c, "audit_admin", "Adm1n-audit-pass")
    login(analyst_c, "audit_analyst", "Analyst-audit-pass")

    # --- Setup as ADMIN: dummy dataset in a members-only project (analyst excluded)
    csv = b"name,email,salary\nAlice,alice@dummy.example,100\nBob,bob@dummy.example,200\n"
    r = admin_c.post("/api/catalog/upload", files={"file": ("secret.csv", io.BytesIO(csv), "text/csv")},
                     data={"name": "audit_secret", "mode": "create"})
    assert r.status_code == 201, r.text
    r = admin_c.post("/api/projects", json={"name": "Restricted Audit", "access": "members",
                                            "members": ["audit_admin"], "datasets": ["audit_secret"]})
    assert r.status_code == 201, r.text
    pid = r.json().get("id") or r.json().get("_id") or r.json().get("project", {}).get("id")
    analyst_doc = auth.users.find_one({"username": "audit_analyst"})
    before = "audit_secret" in projects.allowed_collections(analyst_doc)
    print("setup: analyst can read audit_secret before attack =", before)

    # --- Admin-only account management (expected to be protected)
    record("AZ-01", "analyst POST /api/admin/users (create user)",
           analyst_c.post("/api/admin/users", json={"username": "evil1", "password": "x" * 12,
                                                     "display_name": "e", "role": "admin"}).status_code, {403})
    record("AZ-02", "analyst PATCH /api/admin/users/audit_analyst role=admin",
           analyst_c.patch("/api/admin/users/audit_analyst", json={"role": "admin"}).status_code, {403})
    record("AZ-03", "anonymous GET /api/admin/users", anon.get("/api/admin/users").status_code, {401, 403})

    # --- Admin data visible to analysts
    r = analyst_c.get("/api/admin/users")
    record("AZ-04", "analyst GET /api/admin/users (user list)", r.status_code, {403},
           {"users_returned": len(r.json().get("users", [])) if r.status_code == 200 else None})
    record("AZ-05", "analyst GET /api/admin/audit (admin audit log)", analyst_c.get("/api/admin/audit").status_code, {403})
    record("AZ-06", "analyst GET /api/admin/overview", analyst_c.get("/api/admin/overview").status_code, {403})

    # --- Catalog / schema exposure
    r = analyst_c.get("/api/catalog")
    leaked = "audit_secret" in r.text
    record("AZ-07", "analyst GET /api/catalog shows restricted dataset schema",
           403 if not leaked and r.status_code == 200 else r.status_code, {403},
           {"restricted_dataset_listed": leaked})

    # --- Project permission changes by analyst
    r = analyst_c.patch(f"/api/projects/{pid}", json={"members": ["audit_admin", "audit_analyst"]})
    record("AZ-08", "analyst PATCH restricted project: add self to members", r.status_code, {403, 404})
    after = "audit_secret" in projects.allowed_collections(auth.users.find_one({"username": "audit_analyst"}))
    results[-1]["detail"] = {"analyst_can_read_restricted_after": after}
    print("        analyst can read audit_secret after attack =", after)
    # put it back the way it was (dummy data only)
    admin_c.patch(f"/api/projects/{pid}", json={"members": ["audit_admin"]})

    record("AZ-09", "analyst PATCH restricted project: access=everyone",
           analyst_c.patch(f"/api/projects/{pid}", json={"access": "everyone"}).status_code, {403, 404})
    admin_c.patch(f"/api/projects/{pid}", json={"access": "members"})

    record("AZ-10", "analyst PATCH project enabled=false (switch off for everyone)",
           analyst_c.patch(f"/api/projects/{pid}", json={"enabled": False}).status_code, {403, 404})
    admin_c.patch(f"/api/projects/{pid}", json={"enabled": True})

    record("AZ-11", "analyst POST /api/projects (create project)",
           analyst_c.post("/api/projects", json={"name": "Analyst Made"}).status_code, {403})

    # --- Dataset changes by analyst
    r = analyst_c.post("/api/catalog/upload", files={"file": ("p.csv", io.BytesIO(b"name\nPOISONED\n"), "text/csv")},
                       data={"name": "audit_secret", "mode": "replace"})
    poisoned = client[DB]["audit_secret"].find_one({"name": "POISONED"}) is not None
    record("AZ-12", "analyst upload mode=replace over admin's restricted dataset", r.status_code, {403, 404},
           {"data_replaced": poisoned})

    r = analyst_c.delete("/api/catalog/audit_secret")
    exists = "audit_secret" in client[DB].list_collection_names()
    record("AZ-13", "analyst DELETE /api/catalog/audit_secret", r.status_code, {403, 404},
           {"collection_still_exists": exists})

    # --- Feedback summary exposure
    record("AZ-14", "analyst GET /api/feedback/summary (all users' feedback)",
           analyst_c.get("/api/feedback/summary").status_code, {403})

    # --- Self-service plan escalation
    r = analyst_c.post("/api/account/plan", json={"plan": "team"})
    record("AZ-15", "analyst POST /api/account/plan team (unlimited)", r.status_code, {403})

    # --- Public endpoints
    r = anon.get("/api/health")
    record("AZ-16", "anonymous GET /api/health returns only status+mongodb",
           200 if set(r.json()) <= {"status", "mongodb"} else 299, {200}, {"keys": sorted(r.json())})
    record("AZ-17", "anonymous POST /api/auth/signup (public signup)",
           anon.post("/api/auth/signup", json={"username": "randomperson", "password": "Random-pass-123",
                                                "display_name": "R"}).status_code, {403})
    anon.cookies.clear()
    record("AZ-18", "anonymous GET /api/threads", anon.get("/api/threads/get").status_code, {401, 403, 404, 405})

    # --- Login lockout with spoofed X-Forwarded-For (models Dockerfile --forwarded-allow-ips='*')
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
    auth._failures.clear() if hasattr(auth, "_failures") else None
    with TestClient(ProxyHeadersMiddleware(main.app, trusted_hosts="*")) as px:
        codes = []
        for i in range(12):
            codes.append(px.post("/api/auth/login", json={"username": "audit_admin", "password": "wrong-pass-x"},
                                 headers={"X-Forwarded-For": f"203.0.113.{i + 1}"}).status_code)
    record("AZ-19", "12 wrong passwords, rotating spoofed X-Forwarded-For -> lockout (429)?",
           429 if 429 in codes else 401, {429}, {"codes": codes})

    # --- API key survives password reset
    r = analyst_c.post("/api/account/keys", json={"name": "audit"})
    key = (r.json() or {}).get("key") or (r.json() or {}).get("token")
    if key:
        admin_c.post("/api/admin/users/audit_analyst/password", json={"new_password": "New-analyst-pass-1"})
        anon.cookies.clear()
        r2 = anon.get("/api/threads/get", headers={"Authorization": f"Bearer {key}"})
        record("AZ-20", "API key still works after admin password reset", r2.status_code, {401, 403})
    else:
        print("AZ-20  skipped (no key in response)", r.status_code)

client.drop_database(DB)
out = os.path.join(LOG_DIR, "authz_results.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(results, f, indent=2)
print("audit database dropped; results ->", out)
