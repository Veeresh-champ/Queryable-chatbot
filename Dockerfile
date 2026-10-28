# FastAPI backend. Build from the project root:
#   docker build -t queryable-backend .

# The OpenUI validator is a Node sidecar (openui_test/scripts/openui-validator.mjs)
# that needs node and @openuidev/lang-core.
FROM node:20-bookworm-slim AS openui
WORKDIR /app/openui_test
RUN npm install --no-save --no-audit --no-fund @openuidev/lang-core@0.3.0

FROM python:3.10-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY --from=openui /usr/local/bin/node /usr/local/bin/node
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY backend ./backend
COPY scripts ./scripts
COPY --from=openui /app/openui_test/node_modules ./openui_test/node_modules
COPY openui_test/scripts/openui-validator.mjs ./openui_test/scripts/

RUN useradd --create-home --uid 10001 app && mkdir -p logs && chown app logs
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/livez', timeout=4)"

# One worker: login lockout, the query cache and /api/metrics live in process
# memory. Scale with more containers only after moving them to MongoDB/Redis.
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY:-1} --proxy-headers --forwarded-allow-ips='*'"]
