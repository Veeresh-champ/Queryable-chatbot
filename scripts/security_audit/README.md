# Security audit scripts

Local, non-destructive checks used for the security audit in
[`docs/security/`](../../docs/security/). They never contact the live site.

| Script | What it checks | Needs |
|---|---|---|
| `authz_probe.py` | 20 admin-vs-analyst authorization checks (projects, datasets, admin data, feedback, sign-up, lockout, API keys) | Local MongoDB on `localhost:27017` |
| `llm_probe.py` | Query validator, PII masking and prompt-injection guard | Nothing (database stubbed) |

Both scripts create dummy accounts and data only in a separate database,
`queryable_chatbot_audit`, which is dropped afterwards. LLM API keys are
blanked so no paid API is called.

Run them from the repository root:

```powershell
mkdir audit-out
.venv\Scripts\python.exe -B scripts\security_audit\authz_probe.py . audit-out
.venv\Scripts\python.exe -B scripts\security_audit\llm_probe.py . audit-out
```

Each line prints `OK` (secure) or `VULN` (needs fixing); results are saved
as JSON in `audit-out/`.

Other scans:

```powershell
# Secret scan of the full Git history (offline, values redacted)
docker run --rm --network none -v "${PWD}:/repo:ro" zricethezav/gitleaks:v8.28.0 git /repo --redact

# Frontend dependency advisories
cd openui_test; npm audit --omit=dev
```
