#!/usr/bin/env bash
# Start MongoDB + app for the session (fast — data is already in the Docker volume).

set -euo pipefail
cd "$(dirname "$0")"

echo "Starting MongoDB + app..."
docker compose up -d

echo -n "Waiting for app"
until curl -sf "http://localhost:8080/bad?limit=1" >/dev/null 2>&1; do
  echo -n "."
  sleep 1
done
echo ""

COUNT=$(docker compose exec -T mongo mongosh mongo_demo --quiet --eval 'db.invoices.countDocuments({})' 2>/dev/null | tail -1 | tr -d '[:space:]' || echo "0")

if [[ ! "${COUNT:-0}" =~ ^[0-9]+$ ]] || [[ "$COUNT" -lt 1000 ]]; then
  echo ""
  echo "No demo data found ($COUNT invoices)."
  echo "Run ./setup.sh first (one time, ~3–5 min)."
  exit 1
fi

echo "Ready — http://localhost:8080  ($COUNT invoices loaded)"
echo ""
echo "  ./demo.sh oom       # JVM materialization bug"
echo "  ./demo.sh good      # streaming fix"
echo "  ./demo.sh options   # withOptions() trap"
echo "  mongosh ... --file scripts/seed-demo-scenarios.mongosh.js  # anti-pattern labelled docs"
