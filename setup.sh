#!/usr/bin/env bash
# Run ONCE before your session (takes a few minutes the first time).
# After that, data lives in a Docker volume — ./start.sh is instant.

set -euo pipefail
cd "$(dirname "$0")"

echo ""
echo "=== MongoDB JVM demo — one-time setup ==="
echo ""

echo "[1/3] Start MongoDB (port 27018, data saved in Docker volume)..."
docker compose up -d mongo

echo "[2/3] Wait for MongoDB..."
until docker compose exec -T mongo mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | grep -q '^1$'; do
  sleep 2
done

COUNT=$(docker compose exec -T mongo mongosh mongo_demo --quiet --eval 'db.invoices.countDocuments({})' 2>/dev/null | tail -1 | tr -d '[:space:]' || echo "0")
if [[ "${COUNT:-0}" =~ ^[0-9]+$ ]] && [[ "$COUNT" -gt 0 ]]; then
  echo "      Data already loaded ($COUNT invoices) — skipping seed."
else
  echo "[3/3] Load 100,000 invoices into the volume (~2–5 min, only happens once)..."
  docker compose --profile seed run --rm seed
fi

echo "      Load labelled anti-pattern scenarios (invoices only)..."
docker compose exec -T mongo mongosh mongo_demo --quiet --file /scripts/seed-demo-scenarios.mongosh.js >/dev/null 2>&1 || \
  mongosh mongodb://localhost:27018/mongo_demo --quiet --file scripts/seed-demo-scenarios.mongosh.js

echo ""
echo "Build app image..."
docker compose build app

echo ""
echo "Start app..."
docker compose up -d app

until curl -sf "http://localhost:8080/bad?limit=1" >/dev/null 2>&1; do
  sleep 2
done

echo ""
echo "=== Setup complete ==="
echo ""
echo "  App:    http://localhost:8080"
echo "  Mongo:  mongodb://localhost:27018/mongo_demo"
echo ""
echo "At session time, run:"
echo "  ./start.sh"
echo "  ./demo.sh oom     # show the problem"
echo "  ./demo.sh good    # show the fix"
echo ""
