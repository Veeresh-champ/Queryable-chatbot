# Security Audit — Queryable Chatbot

| | |
|---|---|
| **Audit date** | 13 November 2026 |
| **Scope** | FastAPI backend, Next.js frontend, MongoDB access, LLM/chatbot pipeline, dependencies, Docker / Render / Cloudflare / GitHub Actions configuration |
| **Method** | Static code review, local authorization tests with dummy accounts, offline tests of the query validator and PII masking, secret scan of the full Git history, frontend dependency audit, existing automated test suite |
| **Production testing** | None — no attack traffic was sent to the live site |

> This is the summary. The full technical report is [`SECURITY_AUDIT_REPORT.md`](SECURITY_AUDIT_REPORT.md); raw test and scan results are in [`evidence/`](evidence/); the test scripts are in [`scripts/security_audit/`](../../scripts/security_audit/).

---

## 1. Summary

The audit found that project and dataset permissions were not enforced: any signed-in user could change project access, read restricted data and replace or delete datasets, and public sign-up was enabled by default. **These issues have been fixed, re-tested and deployed.**

Remaining items are mainly Medium and Low hardening work (rate limiting, personal-data masking coverage, dependency updates and deployment configuration). They are tracked below.

| Status | Critical | High | Medium | Low |
|---|---|---|---|---|
| Found | 1 | 7 | 14 | 7 |
| **Fixed and verified** | **1** | **4** | 0 | 0 |
| Open | 0 | 3 | 14 | 7 |

---

## 2. Fixed and verified

| Area | Problem | Fix | Verification |
|---|---|---|---|
| Authorization (Critical) | Any signed-in user could create, edit, delete or re-assign projects, including granting themselves access to restricted projects | All project-changing endpoints in `backend/projects.py` require an administrator | Analyst requests now return **403**; analyst no longer gains access to restricted data |
| Authorization (High) | Any signed-in user could upload, replace, edit or delete datasets | Dataset preview/upload/edit/keep/delete in `backend/data_catalog.py` require an administrator | Analyst requests now return **403**; data unchanged |
| Authorization (High) | Admin overview, user list and admin audit log were visible to all users | Admin-only in `backend/admin.py` | Analyst requests now return **403** |
| Authorization (High) | Feedback summary exposed every user's questions and comments | Admin-only in `backend/feedback.py` | Analyst requests now return **403** |
| Authentication (High) | Public self sign-up enabled by default | `ALLOW_SIGNUP` now defaults to `false` (`backend/config.py`, `render.yaml`, `.env.example`); accounts are created by administrators | Anonymous sign-up returns **403** with default configuration |
| Frontend | Admin console, Data catalog and chat upload were shown to all users | Shown to administrators only | Typecheck, lint and production build pass |

Regression tests were updated to enforce the stricter rules. **Automated test suite: 206 passed, 0 failed.**

---

## 3. Existing protections confirmed

- Passwords hashed with PBKDF2-SHA256 (310 000 iterations, per-user salt, constant-time comparison).
- Server-side sessions in `HttpOnly`, `SameSite=Lax` cookies; `Secure` in production.
- User-account management (create, role change, password reset, sign-out) is administrator-only.
- Chat threads and artifacts are isolated per user.
- The chatbot can only run read operations; database writes, server-side `$where`, `$out`/`$merge` and internal collections are rejected by the query validator.
- Query time limit (5 s) and row limit (200).
- E-mail addresses masked in query results; obvious prompt-injection phrases blocked.
- Origin check on state-changing API requests; security headers (`X-Frame-Options`, `nosniff`, HSTS, Referrer-Policy, Permissions-Policy).
- Docker image runs as a non-root user; `.env` files are git-ignored.
- **Secret scan of the full Git history (Gitleaks): no real secrets found.**

---

## 4. Open items (tracked)

| Area | Severity | Planned fix |
|---|---|---|
| Personal-data masking coverage in chatbot answers | High | Reject queries that reference personal-data fields; broaden field and value masking |
| Data catalog read scope | High | Limit catalog details to datasets in the user's projects |
| Analytics pages project scoping | High | Enforce project access and per-user caching on analytics endpoints |
| Plan changes by users | Medium | Administrator-only plan changes |
| Login rate limiting behind proxies | Medium | Per-account limits; trust only the hosting proxy |
| Query validator hardening | Medium | Recursive validation of expression filters |
| Chat history handling | Medium | Rebuild conversation history on the server |
| Prompt-injection defence | Medium | Defence in depth beyond phrase matching |
| Content-Security-Policy and external links | Medium | Add CSP; https-only links with confirmation |
| LLM usage limits | Medium | Per-user rate limit, output token limits, model choice per plan |
| Database privileges for chatbot queries | Medium | Separate read-only database user |
| Upload resource limits | Medium | Streaming parsing with row/column/cell limits |
| Frontend dependencies (5 high, 4 low advisories) | Medium | Update `zod`, `source-map-js`; track upstream packages |
| CI/CD | Medium | Gate deploys on CI; least-privilege workflow permissions; security scans in CI |
| Base images | Medium | Move to supported Node and Python versions |
| Local secret storage | Medium | Keep `.env` out of cloud-synced folders; rotate keys |
| Health endpoint detail, API key revocation on password reset, secure-cookie default, login timing, CSV export formulas, public API docs, audit logging/alerting | Low | Hardening backlog |

---

## 5. Tools

| Tool | Used | Notes |
|---|---|---|
| pytest | Yes | 206 tests |
| Custom authorization tests | Yes | 20 admin-vs-analyst checks against a throw-away local database |
| Gitleaks | Yes | Full history, redacted, offline |
| npm audit | Yes | Production dependencies |
| Bandit, pip-audit, Semgrep, Trivy, OWASP ZAP | Not yet | Recommended additions to CI (`pip install bandit pip-audit semgrep`; ZAP against a local or staging copy only) |

---

## 6. Reporting a vulnerability

Please do not open a public issue for security problems. Contact the repository owner directly.
