#!/usr/bin/env bash
# One-command demo startup for the ThBw RAG prototype.
# Checks Ollama, starts the optional rerank sidecar and the server,
# waits for health, opens the browser. Idempotent: running services are
# left alone. Stop everything with:  pkill -f 'node server/server.js'; pkill -f 'rerank/server.py'
set -euo pipefail
cd "$(dirname "$0")"

echo "[1/4] Ollama ..."
if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  open -a Ollama 2>/dev/null || brew services start ollama 2>/dev/null || true
  for i in $(seq 1 15); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
fi
curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && echo "      ok" || { echo "      ERROR: Ollama not reachable"; exit 1; }

echo "[2/4] Rerank sidecar (optional) ..."
if curl -sf http://127.0.0.1:5056/health >/dev/null 2>&1; then
  echo "      already running"
elif command -v uv >/dev/null 2>&1 && [ -d rerank ]; then
  (uv run --project rerank python rerank/server.py > /tmp/thbw-rerank.log 2>&1 &)
  for i in $(seq 1 30); do curl -sf http://127.0.0.1:5056/health >/dev/null 2>&1 && break; sleep 2; done
  curl -sf http://127.0.0.1:5056/health >/dev/null 2>&1 && echo "      ok" || echo "      not up (server will run without rerank)"
else
  echo "      skipped (uv not found) — server runs without rerank"
fi

echo "[3/4] Server ..."
if ! curl -sf http://localhost:5055/api/health >/dev/null 2>&1; then
  [ -f .env ] || { echo "      ERROR: .env missing (cp .env.example .env, add DEEPSEEK_API_KEY)"; exit 1; }
  (npm start > /tmp/thbw-server.log 2>&1 &)
  for i in $(seq 1 30); do curl -sf http://localhost:5055/api/health >/dev/null 2>&1 && break; sleep 1; done
fi
curl -s http://localhost:5055/api/health || { echo "      ERROR: server did not start — see /tmp/thbw-server.log"; exit 1; }
echo

echo "[4/4] Opening http://localhost:5055"
open http://localhost:5055 2>/dev/null || true
echo "Done. Logs: /tmp/thbw-server.log, /tmp/thbw-rerank.log"
