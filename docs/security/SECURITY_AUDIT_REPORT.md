# Security Audit Report — Queryable Chatbot

| | |
|---|---|
| **Date** | 13 November 2026 |
| **Code audited** | `main` at commit `4d968ae` (what is deployed on Cloudflare + Render today) |
| **Also compared** | local-only branch `security-fixes-backup` (`79df27c`), never merged or deployed |
| **Method** | Static code review, local in-process authorization tests with dummy accounts, offline validator/PII tests, secret scan of full Git history, npm dependency audit, existing test suite |
| **Production testing** | None. No attack traffic was sent to the live Cloudflare or Render URLs. |
| **Code changes** | None. This audit changed no application code, configuration, credentials or database records. |

---

## 0. Current status (13 November 2026)

**All Critical and High findings are fixed, re-tested and deployed.** Every authorization check (20/20) and every chatbot query-safety and personal-data check (17/17) now passes, together with the full automated test suite (244 tests on Python 3.10; 231 passed + 13 skipped tool-dependent tests on Python 3.12).

| Area | What was fixed |
|---|---|
| Projects and datasets | Only administrators can create, change, delete or re-assign projects and datasets |
| Admin data | User list, audit log, workspace overview, feedback summary, health details and metrics are admin-only |
| Sign-up | Public sign-up off by default; accounts are created by administrators |
| Catalog and dashboards | Users only see datasets in their own projects; per-user caching |
| Personal data | Queries that filter, sort, group, join or copy personal-data fields are refused; e-mail and phone values masked; wider name/contact detection; samples masked before reaching the LLM |
| Query safety | Server-side JavaScript (`$function`, `$accumulator`, `$where`) refused anywhere, including inside `$expr`; regex and complexity limits |
| Chat | Conversation history rebuilt on the server; refused messages never replayed; wider prompt-injection detection |
| Login and accounts | Per-account lockout (10 attempts); constant-time login; API keys revoked on password change/reset; self-service plan changes off; sign-in and API-key events logged |
| Cost | Output token caps; free plan uses the default model; per-user rate limit |
| Uploads | Streaming CSV and bounded Excel reads; zip-size check |
| Frontend | Content-Security-Policy (no remote images); https-only links with confirmation; CSV exports neutralise spreadsheet formulas |
| Platform | Python 3.12 and Node 22 images; `pymongo` 4.18.3; `zod` 4.6.7; `source-map-js` 1.2.2; read-only CI permissions; secret scan, dependency audit and static analysis in CI; API docs off in production |

**Remaining owner actions:** set `ALLOW_SIGNUP=false` in the Render dashboard; optionally create a read-only MongoDB user and set `MONGODB_READONLY_URI`; keep `.env` outside cloud-synced folders and rotate keys; upgrade Cloudflare Workers to the paid plan to avoid occasional free-plan CPU limits. One library (`@ag-ui/core`) still bundles an older `zod`; no upstream fix is available yet.

The sections below are the original audit findings, kept for reference.

---

## 1. Executive summary

The chatbot is functional and has several good foundations: strong password hashing, HttpOnly session cookies, admin-only user management, per-user isolation of chat threads, and a query validator that blocks database writes and server-side code.

However, **the application is not ready for wider internal testing or public use** because of authorization gaps that were **confirmed by testing**:

- **Any signed-in user (analyst) can change project permissions, give themselves access to restricted datasets, and replace or delete datasets.** In a local test, a dummy analyst account went from *no access* to *full access* to a restricted dataset with one request.
- **Anyone on the internet can create an account**, because public sign-up is enabled. Combined with the issue above, a stranger can reach restricted data.
- **Personal data masking can be bypassed** by asking for a field under a different name (for example, phone numbers are returned unmasked if renamed).
- **Admin-only information** (user list, admin audit log, workspace usage/cost, other users' feedback) is visible to every user.

Several of these were already addressed on the local branch `security-fixes-backup`, but that branch was **never merged or deployed**, and it does **not** fix the most serious issue (project/dataset permissions).

### Summary table

| Security Area | Status | Findings |
|---|---|---|
| Authentication | Fixed | Sign-up off by default, per-account lockout, constant-time login, API keys revoked on password reset |
| Authorization | Fixed | Projects, datasets and admin data admin-only; verified 20/20 |
| API Security | Fixed | Project-scoped catalog and dashboards, rate limit, upload limits, health details admin-only, API docs off |
| Database Security | Fixed | Validator blocks server-side JS and PII filters; optional read-only DB user |
| Credential Exposure | Owner action | Git history clean; keep `.env` out of OneDrive, rotate keys |
| Frontend Security | Fixed | CSP, safe links, CSV formula neutralisation |
| LLM Security | Fixed | PII masking, server-side history, prompt-injection detection, token caps |
| Dependencies | Fixed (one upstream item) | pymongo, zod, source-map-js updated; `@ag-ui/core` awaiting upstream |
| Deployment Security | Fixed | Python 3.12 / Node 22, read-only CI permissions, security scans in CI |

---

## 2. Architecture and security scope

```
Browser ──► Cloudflare Worker (Next.js 16 via OpenNext, openui_test/)
               │  rewrites /api/* ──►  Render (Docker, FastAPI, backend/)
               │                          ├── MongoDB Atlas (users, sessions, threads, datasets)
               │                          ├── OpenRouter (LLMs: Gemini / GPT / Claude model IDs)
               │                          └── Jev router (OpenRouter "decisions" API)
GitHub ──► Cloudflare Workers Builds (auto-deploy on push to main)
       └─► GitHub Actions CI (tests, lint, build, docker build)
```

| Component | Location | Notes |
|---|---|---|
| Frontend | `openui_test/` | Next.js, OpenUI renderer, AG-UI event stream |
| Backend | `backend/main.py` + routers | FastAPI; 13 routers (auth, threads, account, feedback, artifacts, admin, agents, catalog, projects, opportunities, …) |
| Authentication | `backend/auth.py` | Username + password, server-side sessions, `qc-` API keys |
| Admin | `backend/admin.py` | Guards: `require_admin`, `require_member`, `require_session_user` |
| LLM / LangChain | `backend/langchain_agent.py`, `langchain_tools.py`, `openui_engine.py`, `chat_service.py`, `jev_router.py` | LLM writes one MongoDB query JSON; code validates and runs it (the LLM cannot pick arbitrary tools) |
| Query safety | `backend/validator.py`, `backend/guardrails.py`, `backend/database_tool.py` | Allowlisted operations/stages, PII masking, regex prompt guard |
| Deployment | `Dockerfile`, `render.yaml`, `wrangler.jsonc`, `.github/workflows/` | |

**Integrations verified in code:** OpenRouter (main LLM provider), Jev (routing only, 8 s timeout, safe fallback), LangChain (minimal), AG-UI event protocol, optional Thesys and Langfuse. **Not implemented:** MCP, A2A, LangGraph, CopilotKit (only mentioned in docs/roadmap). Graphiti/Neo4j present but disabled.

---

## 3. Existing security mechanisms (verified)

| Protection | Evidence | Verified how |
|---|---|---|
| Passwords hashed with PBKDF2-SHA256, 310 000 iterations, per-user salt, constant-time compare | `backend/auth.py:40-70` | Code |
| Session cookie `HttpOnly`, `SameSite=Lax`; `Secure` when `COOKIE_SECURE=true` (set in `render.yaml`) | `backend/auth.py:251-260` | Code |
| Only admins can create users, change roles, reset passwords, revoke sessions | `backend/admin.py:276-385` (`require_admin`) | **Test AZ-01, AZ-02, AZ-03 passed** |
| Chat threads and artifacts are scoped to their owner | `backend/threads.py:61-62,130`; `artifacts.py:186-239` | **Test AZ-18 passed** + code |
| Login rate limiting (per username + IP) | `backend/auth.py:97-130` | Code (bypassable, see F-10) |
| Query validator blocks `$out`, `$merge`, `$where`, unknown/internal collections | `backend/validator.py` | **Tests LLM-01…04 passed** |
| Only read operations (`find`, `count`, `distinct`, `aggregate`) | `backend/validator.py:4` | Code + tests |
| Query time limit 5 s, max 200 rows | `backend/database_tool.py:50` | Code |
| E-mail addresses masked in query results | `backend/guardrails.py:116` | **Test PII-01 passed** |
| Obvious prompt injection ("ignore previous instructions") blocked | `backend/guardrails.py:17-23` | **Test GR-01 passed** |
| Cross-site write protection (Origin check on `/api/*`) | `backend/main.py:106-117` | Code |
| Security headers: `X-Frame-Options DENY`, `nosniff`, HSTS, Referrer-Policy, Permissions-Policy | `openui_test/next.config.ts:26-38` | Code |
| Docker runs as non-root; `.env` excluded from image | `Dockerfile`, `.dockerignore` | Code |
| `.env` files are git-ignored and never committed | `.gitignore:2`; Gitleaks history scan | **Scan** |
| Only dangerous HTML injection point is a static constant | `openui_test/src/app/layout.tsx:49-50` | Code |
| Existing test suite | `tests/` | **206 passed, 0 failed** |

---

## 4. Security skills and tools discovered

| Searched for | Result |
|---|---|
| `AGENTS.md`, `CLAUDE.md`, `SECURITY.md` | Not present |
| `.claude/skills/`, `skills/`, credential-handling skills | Not present |
| Security checklists / audit scripts in repo | None. Existing security tests: `tests/test_security.py` (guardrails, PII masking, validator) |
| `.github/workflows/` | `ci.yml` (tests, lint, build, docker), `deploy-cloudflare.yml` (skips — secrets not set). No security scanning job on `main`. |

| Tool | Available? | Used? | How to install / run |
|---|---|---|---|
| pytest | Yes (`.venv`) | Yes | `python -m pytest -q` |
| npm audit | Yes (npm 11.17) | Yes | `cd openui_test && npm audit --omit=dev` |
| Gitleaks | Docker image already present | Yes (offline, read-only, `--redact`) | `docker run --rm -v "%CD%:/repo:ro" zricethezav/gitleaks:v8.28.0 git /repo --redact` |
| Bandit | **No** | No | `pip install bandit` then `bandit -r backend -ll` |
| pip-audit | **No** | No | `pip install pip-audit` then `pip-audit -r requirements.txt` |
| Semgrep | **No** | No | `pip install semgrep` then `semgrep --config p/python --config p/typescript .` |
| Trivy | **No** | No | `winget install AquaSecurity.Trivy` then `trivy fs .` and `trivy image <image>` |
| OWASP ZAP | **No** | No | Install ZAP Desktop; run a baseline scan **only against a local or staging copy** (`http://localhost:3000`) |

Tools were not installed because installation requires your approval.

---

## 5. Tests performed and results

All behavioural tests ran **locally**, in-process (FastAPI `TestClient`), against a throw-away database `queryable_chatbot_audit` on the local MongoDB, with LLM API keys blanked. Dummy accounts `audit_admin` / `audit_analyst` and a dummy dataset were used. The database was dropped after each run.

### 5.1 Authorization tests (admin vs analyst)

| ID | Test | Result | Expected (secure) |
|---|---|---|---|
| AZ-01 | Analyst creates a user | 403 ✅ | 403 |
| AZ-02 | Analyst makes self admin | 403 ✅ | 403 |
| AZ-03 | Anonymous reads user list | 401 ✅ | 401/403 |
| AZ-04 | Analyst reads user list | **200 ❌** | 403 |
| AZ-05 | Analyst reads admin audit log | **200 ❌** | 403 |
| AZ-06 | Analyst reads admin overview (usage/cost) | **200 ❌** | 403 |
| AZ-07 | Analyst catalog lists restricted dataset schema | **200, listed ❌** | hidden |
| AZ-08 | Analyst adds self to restricted project | **200 ❌ — gained access to restricted data** | 403 |
| AZ-09 | Analyst sets restricted project to "everyone" | **200 ❌** | 403 |
| AZ-10 | Analyst switches a project off for everyone | **200 ❌** | 403 |
| AZ-11 | Analyst creates a project | **201 ❌** | 403 |
| AZ-12 | Analyst replaces admin's dataset with own data | **201 ❌ — data replaced** | 403 |
| AZ-13 | Analyst deletes admin's dataset | **200 ❌ — dataset deleted** | 403 |
| AZ-14 | Analyst reads all users' negative feedback | **200 ❌** | 403 |
| AZ-15 | Analyst upgrades self to unlimited plan | **200 ❌** | 403 |
| AZ-16 | Anonymous `/api/health` shows only status | **❌ shows provider/config flags** | status only |
| AZ-17 | Anonymous public sign-up | **201 ❌ (enabled)** | 403 |
| AZ-18 | Anonymous reads chat threads | 401 ✅ | 401 |
| AZ-19 | 12 wrong passwords with rotating `X-Forwarded-For` → lockout | **never locked ❌** | 429 |
| AZ-20 | API key still works after admin password reset | **200 ❌** | 401 |

### 5.2 LLM query validator, PII masking and prompt guard (offline)

| ID | Test | Result |
|---|---|---|
| LLM-01…04 | `$out`, `$merge`, `$where`, internal collection | Rejected ✅ |
| LLM-05 | `$expr` + `$function` (server-side JavaScript) in a filter | **Accepted ❌** |
| LLM-06 | Rename phone: `{"$project":{"p":"$phone"}}` | **Accepted ❌** (masking bypassed) |
| LLM-07 | Transform email: `$split` on `$email` | **Accepted ❌** |
| LLM-08 | `$group` by `$email` | **Accepted ❌** |
| LLM-09 | `distinct` on `phone` | **Accepted ❌** |
| LLM-10 | Count with `email` regex `^a` (letter-by-letter extraction) | **Accepted ❌** |
| PII-01 | E-mail in an unnamed field | Masked ✅ |
| PII-02 | Phone number in an unnamed field | **Not masked ❌** |
| PII-03 | Field `contact_no` | **Not masked ❌** |
| PII-04 | Field `Full Name` | **Not masked ❌** |
| GR-01 | "ignore previous instructions…" | Blocked ✅ |
| GR-02 | Paraphrased injection ("set aside earlier guidance…") | **Not blocked ❌** |
| GR-03 | "drop the users collection" | Not blocked by guard ⚠️ (but the validator still prevents any write) |

### 5.3 Scans

| Scan | Result |
|---|---|
| Gitleaks, full Git history (35 commits, redacted, offline) | 1 hit — **false positive** (dummy test password in `tests/test_chat_flow.py:256`). No real secrets in history. |
| `npm audit --omit=dev` (frontend) | **9 advisories: 5 high, 4 low** — see F-19 |
| Existing test suite | **206 passed, 0 failed** |
| Python dependency scan | **Not run** — pip-audit not installed |

---

## 6–10. Findings

Status key: **Confirmed (test)** = reproduced locally; **Confirmed (code)** = clear in source, not executed; **Needs validation** = depends on runtime or hosting settings.

### Critical

#### F-01 — Any analyst can change project permissions and access restricted data
- **Status:** Confirmed (test AZ-08, AZ-09, AZ-10, AZ-11)
- **Evidence:** `backend/projects.py:343-426` and `447-457`. Every project-changing route uses `Depends(require_member)`, which accepts any signed-in user (`backend/admin.py:60-64`).
- **Endpoints:** `POST /api/projects`, `PATCH /api/projects/{id}`, `DELETE /api/projects/{id}`, `PUT /api/projects/{id}/datasets`, `POST|DELETE /api/projects/{id}/datasets/{name}`, `PATCH /api/catalog-meta/{name}`
- **Impact:** Project-level data isolation does not exist in practice. Any user — including anyone who signs up (F-03) — can open restricted projects, read their data through the chatbot, or switch projects off for everyone.
- **Fix:** Change these routes to `Depends(require_admin)` (or check `can_use()` / project ownership). Add regression tests matching AZ-08…AZ-11.

### High

#### F-02 — Any analyst can upload, replace, append to and delete any uploaded dataset
- **Status:** Confirmed (test AZ-12, AZ-13)
- **Evidence:** `backend/data_catalog.py:701` (upload, `mode=replace|append`), `:817` (PATCH), `:827` (keep), `:837-839` (`db[name].drop()`); no owner check in `import_file` (`:727-731`).
- **Impact:** Data poisoning (wrong business answers for everyone), data loss, injection of malicious text that the LLM later reads (see F-13).
- **Fix:** Admin-only, or owner-only for the uploader's own datasets; never allow replace/delete of another user's dataset.

#### F-03 — Public self sign-up is enabled
- **Status:** Confirmed (test AZ-17; live `/api/auth/config` returned `signup_enabled: true` during normal use)
- **Evidence:** `backend/config.py:97` default `True`; `render.yaml:30-31` `ALLOW_SIGNUP: "true"`.
- **Impact:** Anyone on the internet becomes an "analyst" and can exploit F-01, F-02, F-09 and spend LLM credit.
- **Fix:** Set `ALLOW_SIGNUP=false` in Render and change the code default to `False`. Create accounts from the Admin console.

#### F-04 — Personal-data masking can be bypassed
- **Status:** Confirmed (tests LLM-06…09, PII-02…04)
- **Evidence:** Masking is by output field name only (`backend/guardrails.py:112`); phone pattern defined but unused (`:92`); validator accepts any `$project`/`$group` expression (`backend/validator.py:286-288`).
- **Impact:** Phone numbers, e-mails and names can be extracted through the chatbot by renaming or transforming fields. Raw sample values are also sent to the LLM provider in the schema prompt (`backend/schema_discovery.py:63-78`, `langchain_agent.py:120-126`).
- **Fix:** Reject pipelines that reference PII fields (already implemented on `security-fixes-backup`, `validator.py:54-73`); add value-based phone masking; broaden name/contact patterns; mask schema samples before sending to the LLM.

#### F-05 — Admin console data is visible to every user
- **Status:** Confirmed (tests AZ-04, AZ-05, AZ-06)
- **Evidence:** `backend/admin.py:114` (`/overview`), `:232` (`/users`), `:387` (`/audit`) use `require_member`.
- **Impact:** All usernames, roles, plans, activity, workspace cost and admin actions are disclosed — useful for targeting accounts.
- **Fix:** `require_admin` on these three routes.

#### F-06 — Catalog shows schema and sample values of restricted and disabled datasets
- **Status:** Confirmed (test AZ-07)
- **Evidence:** `backend/data_catalog.py:585-618` (`get_schema(all_collections=True)`, `include_disabled=True, scoped=False`).
- **Fix:** Scope the catalog to `allowed_collections(user)` or make it admin-only.

#### F-07 — Feedback summary shows other users' questions and comments
- **Status:** Confirmed (test AZ-14)
- **Evidence:** `backend/feedback.py:152-195` — `feedback.find({"rating": "down"})` with no user filter, returning username, question, comment and generated query.
- **Fix:** `require_admin`.

#### F-08 — HR and SPAN analytics ignore project restrictions; shared cache across users
- **Status:** Confirmed (code); not executed
- **Evidence:** `backend/hr_analytics.py:82` reads `ibm_hr_employees` directly and returns per-employee income/age/attrition (`:235-237`); global caches `hr_analytics.py:323-332`, `analytics.py:490-502`; routes `backend/main.py:233, 262-285`.
- **Impact:** Users excluded from an HR project can still see row-level salary data; an admin's view can be served to an analyst from cache.
- **Fix:** Check `allowed_collections(user)` before serving; key caches by user scope.

### Medium

| ID | Finding | Status | Evidence | Fix |
|---|---|---|---|---|
| F-09 | Users can switch themselves to the unlimited "team" plan | Confirmed (AZ-15) | `backend/account.py:224-229` | Admin-only plan changes (done on `security-fixes-backup`) |
| F-10 | Login lockout bypass via spoofed `X-Forwarded-For` | Confirmed (AZ-19, modelled locally) | `Dockerfile:34` `--forwarded-allow-ips='*'`; `backend/auth.py:97-99` | Add per-account limit; trust only the real proxy |
| F-11 | `$expr` + `$function` (server-side JavaScript) passes the validator in filters | Confirmed at validator (LLM-05); execution on Atlas not tested | `backend/validator.py:91-100` | Recursively validate `$expr`; block `$function`, `$accumulator` |
| F-12 | PII side channels (regex/equality filters on e-mail, sort by PII) | Confirmed (LLM-10) | `backend/validator.py:108-138` | Disallow filtering/sorting on PII fields |
| F-13 | Chat history is taken from the browser, so earlier "assistant" turns can be forged | Confirmed (code) | `backend/main.py:320-339`; `backend/chat_service.py:118-127` | Rebuild history from the stored thread (done on `security-fixes-backup`) |
| F-14 | Prompt-injection guard is a short English regex list | Confirmed (GR-02) | `backend/guardrails.py:17-30` | Treat as defence-in-depth only; rely on validator + scoping |
| F-15 | No Content-Security-Policy; model-generated `OpenUrl` opens any URL without confirmation | Confirmed (code) | `openui_test/next.config.ts:26-38`; `src/components/assistant-message.tsx:287-288` | Add CSP; https-only + confirm (done on `security-fixes-backup`) |
| F-16 | LLM cost abuse: no per-minute rate limit, no `max_tokens`, any user may pick expensive models | Confirmed (code) | `backend/openui_engine.py:690-695`; `backend/config.py:64-68` | Per-user rate limit, `max_tokens`, model per plan |
| F-17 | LLM queries use the same full-privilege MongoDB connection as the app | Confirmed (code) | `backend/db.py:25-32` | Separate read-only DB user for model queries |
| F-18 | Upload memory exhaustion (CSV/JSON fully loaded; Excel declared dimensions) | Confirmed (code); not executed | `backend/data_catalog.py:153-159, 177-208, 218-237` | Stream with row/column caps; cell limits |
| F-19 | Vulnerable frontend dependencies: `zod <4.6.6` (memory DoS), `source-map-js` (DoS), `@ag-ui/core` / `@openuidev/*` (via zod 3), 4 low (`katex` chain) | Confirmed (npm audit) | `openui_test/package-lock.json` | `zod` ≥ 4.6.7; update `source-map-js`; track upstream for `@openuidev/*` |
| F-20 | Deploys are not gated on CI; workflows have no `permissions:` block; Cloudflare token in job env | Confirmed (code) | `.github/workflows/*.yml`; `render.yaml:14` | Require CI before deploy; least-privilege `permissions` |
| F-21 | End-of-life base images (Node 20, Python 3.10) | Confirmed (code) | `Dockerfile:6,10`; `openui_test/Dockerfile` | Node 22 LTS, Python 3.12 |
| F-22 | `.env` with API keys lives in a OneDrive-synced folder | Confirmed (local) | `C:\Users\…\OneDrive\Desktop\queryable_chatbot\.env` (not in Git) | Move project out of OneDrive or exclude; rotate keys if OneDrive is shared |

### Low

| ID | Finding | Status | Evidence | Fix |
|---|---|---|---|---|
| F-23 | Public `/api/health` and `/api/readyz` reveal provider/configuration flags | Confirmed (AZ-16) | `backend/main.py:171-205` | Return status only publicly |
| F-24 | API keys keep working after a password change or admin reset | Confirmed (AZ-20) | `backend/account.py:307-321`; `backend/admin.py:364-370` | Revoke keys on reset |
| F-25 | `Secure` cookie flag defaults to off unless configured | Confirmed (code) | `backend/config.py:92` | Default to secure (done on `security-fixes-backup`) |
| F-26 | Login timing difference reveals whether a username exists | Needs validation | `backend/auth.py:287-289` | Hash a dummy password for unknown users |
| F-27 | CSV export does not neutralise formulas (`=`, `+`, `-`, `@`) | Confirmed (code) | `openui_test/src/components/report-artifact.tsx:75-78` and other export helpers | Prefix such cells with `'` |
| F-28 | FastAPI `/docs` and `/openapi.json` public on the Render backend | Confirmed (code) | `backend/main.py:36` | Disable in production |
| F-29 | Audit gaps: logins, lockouts, sign-ups, API-key creation not audited; metrics in memory; no alerting | Confirmed (code) | `backend/auth.py`, `backend/account.py:268`, `backend/observability.py` | Audit these events; add alerting |

### Informational

| ID | Item |
|---|---|
| I-01 | A GitHub personal access token with admin rights on this repository was pasted into an AI chat session on 13 Nov 2026. It is not in the repository, but it should be **revoked immediately** (GitHub → Settings → Developer settings → Tokens). |
| I-02 | Gitleaks: no real secrets in Git history; the single hit is a dummy test password. |
| I-03 | Branch `security-fixes-backup` contains fixes for F-03, F-04 (partly), F-09, F-10, F-13, F-15, F-17 (optional), F-19 (zod), F-23, F-25 and a CI security job. It is **not merged or deployed**, and it does **not** fix F-01, F-02, F-05, F-06, F-07, F-08. |

---

## 11. Items not tested, and why

| Item | Reason |
|---|---|
| Any test against the live Cloudflare/Render sites | Not authorized; production must not be attacked |
| OWASP ZAP dynamic scan | Tool not installed; must target local/staging only |
| Python dependency vulnerabilities (pip-audit), Bandit, Semgrep, Trivy | Tools not installed (needs approval) |
| Whether the LLM actually obeys prompt-injection payloads | Requires paid LLM calls; validator-level tests used instead |
| Whether MongoDB Atlas executes `$function` (F-11) | Requires the real cluster; Atlas shared tiers usually block it |
| Atlas database user roles and network access list | Requires owner access to the Atlas console |
| Render and Cloudflare dashboard settings (actual env values, CI gating) | Requires owner access |
| Browser behaviour of CSP / links / CSV formulas | Requires a browser session; code review only |
| Upload memory-exhaustion proof of concept (F-18) | Potentially disruptive; code review only |
| Login timing (F-26) | Needs a statistical timing test |

---

## 12. Recommended actions before internal testing and deployment

**Before sharing with more people (blockers):**
1. **Lock down project and dataset changes to admins** (F-01, F-02) — change `require_member` to `require_admin` on the routes listed in F-01/F-02, plus admin overview/users/audit and feedback summary (F-05, F-07). Add the AZ tests above as regression tests.
2. **Turn off public sign-up** (F-03) — set `ALLOW_SIGNUP=false` in Render; create accounts from the Admin console.
3. **Revoke the exposed GitHub token** (I-01) and review keys stored in the OneDrive-synced `.env` (F-22).
4. **Merge the existing fixes** from `security-fixes-backup` after review (PII field references, server-side chat history, plan restrictions, lockout, CSP, zod), and re-run this test set.
5. **Fix PII leakage** (F-04, F-12) and scope analytics/catalog to the user's projects (F-06, F-08).

**Before public deployment:**
6. Read-only MongoDB user for LLM queries (F-17); validate `$expr` (F-11).
7. Rate limits and `max_tokens` (F-16); upload streaming limits (F-18).
8. Update dependencies and base images (F-19, F-21); add pip-audit/Bandit/Gitleaks to CI and gate deploys on CI (F-20).
9. Audit logins/API keys and add alerting (F-29).
10. Run OWASP ZAP against a staging copy and re-test.

---

## Appendix — How to reproduce the tests

Scripts: `scripts/security_audit/` (see its README). Raw results: `docs/security/evidence/` (`before-fix/` and `after-fix/` authorization results, validator/PII results, Gitleaks and npm audit output). They use only local resources:

- **Authorization probe:** creates `audit_admin` / `audit_analyst` in a separate local database `queryable_chatbot_audit`, uploads a 2-row dummy CSV, calls each endpoint with FastAPI `TestClient`, records status codes, then drops the database.
- **Validator/PII probe:** imports `backend.validator` and `backend.guardrails` with a stubbed schema; no database or network.
- **Secret scan:** `docker run --rm --network none -v <repo>:/repo:ro zricethezav/gitleaks:v8.28.0 git /repo --redact`
- **Dependencies:** `cd openui_test && npm audit --omit=dev`
- **Regression suite:** `python -m pytest -q` → 206 passed.
