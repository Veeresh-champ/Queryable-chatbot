# Queryable Chatbot: frontend

Next.js 16 + OpenUI interface for the Queryable Chatbot. It holds **no API keys**: every `/api/*` request is proxied to the FastAPI backend (see `next.config.ts`).

```bash
npm install
npm run dev        # http://localhost:3000 (the backend must run on 127.0.0.1:8000)
```

| Script | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run typecheck` / `npm run lint` | Checks run in CI |
| `npm run openui:assets` | Regenerate `backend/openui/` library + prompt |

To point at a different backend, copy `.env.example` to `.env.local` and set `BACKEND_URL`.

Full setup instructions are in the [root README](../README.md).
