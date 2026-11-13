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

**All Critical and High findings are fixed, re-tested and deployed.** All 20 authorization checks and all 17 chatbot query-safety and personal-data checks pass, together with the full automated test suite. See section 0 of the [full report](SECURITY_AUDIT_REPORT.md) for the list of fixes.

## 2. Remaining owner actions

- Set `ALLOW_SIGNUP=false` in the Render dashboard.
- Optional: a read-only MongoDB user for chatbot queries (`MONGODB_READONLY_URI`).
- Keep `.env` out of cloud-synced folders; rotate API keys.
- Upgrade Cloudflare Workers to the paid plan to avoid occasional free-plan CPU-limit errors.

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

## 4. Tools

| Tool | Used | Notes |
|---|---|---|
| pytest | Yes | 206 tests |
| Custom authorization tests | Yes | 20 admin-vs-analyst checks against a throw-away local database |
| Gitleaks | Yes | Full history, redacted, offline |
| npm audit | Yes | Production dependencies |
| Bandit, pip-audit, Semgrep, Trivy, OWASP ZAP | Not yet | Recommended additions to CI (`pip install bandit pip-audit semgrep`; ZAP against a local or staging copy only) |

---

## 5. Reporting a vulnerability

Please do not open a public issue for security problems. Contact the repository owner directly.
