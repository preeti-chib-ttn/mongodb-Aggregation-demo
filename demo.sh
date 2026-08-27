#!/usr/bin/env bash
# Session demo commands — run after ./start.sh

set -euo pipefail
cd "$(dirname "$0")"

LIMIT="${LIMIT:-100000}"

usage() {
  cat <<'EOF'
Usage:
  ./demo.sh oom          Show the bug — app loads ALL results into JVM memory → crash
  ./demo.sh good         Show the fix — app streams one document at a time → works
  ./demo.sh options      Aggregation withOptions() trap — broken vs fixed (Spring only)
  ./demo.sh stop         Stop MongoDB and app
  ./demo.sh reset        Delete volume and re-run setup from scratch

Optional:
  LIMIT=500   ./demo.sh oom    # small limit — completes without OOM
  LIMIT=100000 ./demo.sh oom   # default — triggers OOM on 64 MB heap
  ORG_ID=org-beta ./demo.sh options
EOF
}

wait_for_app() {
  local attempts=0
  until curl -sf "http://localhost:8080/bad?limit=1" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [[ $attempts -gt 60 ]]; then
      echo "App not ready. Run ./start.sh first." >&2
      exit 1
    fi
    sleep 1
  done
}

wait_for_options_endpoint() {
  local attempts=0
  until curl -sf "http://localhost:8080/options/fixed?orgId=org-alpha&limit=1" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [[ $attempts -gt 90 ]]; then
      echo "App not ready or /options endpoints missing. Rebuild failed?" >&2
      exit 1
    fi
    sleep 1
  done
}

call_bad_endpoint() {
  local limit="$1"
  local response_file
  response_file=$(mktemp)

  # -s only (no -S): never print curl errors to the console
  local http_code
  http_code=$(curl -s -o "$response_file" -w "%{http_code}" \
    "http://localhost:8080/bad?limit=${limit}" 2>/dev/null || echo "000")

  if [[ "$http_code" == "200" ]] && [[ -s "$response_file" ]]; then
    cat "$response_file"
    echo ""
    echo "OK — request completed without OOM."
    if [[ "$limit" -lt 20000 ]]; then
      echo "Tip: use a higher LIMIT to trigger OOM on 64 MB heap (e.g. LIMIT=100000)."
    fi
  elif [[ "$http_code" == "000" ]]; then
    echo "Connection lost — JVM likely ran out of memory (expected for large LIMIT on 64 MB heap)."
  else
    [[ -s "$response_file" ]] && cat "$response_file" && echo ""
    echo "Request failed (HTTP $http_code) — likely OutOfMemoryError in the JVM."
  fi

  rm -f "$response_file"
}

case "${1:-}" in
  oom)
    echo ""
    echo "=== BAD endpoint — loads every document into JVM memory ==="
    echo "Restarting app with a tiny heap (64 MB)..."
    docker compose -f docker-compose.yml -f docker-compose.oom.yml up -d --no-deps app >/dev/null 2>&1
    wait_for_app
    echo "Calling GET /bad?limit=$LIMIT ..."
    echo ""
    call_bad_endpoint "$LIMIT"
    echo ""
    echo "Restarting app with normal heap..."
    docker compose up -d --no-deps app >/dev/null 2>&1
    wait_for_app
    echo "Done. Now run: ./demo.sh good"
    ;;

  good)
    echo ""
    echo "=== GOOD endpoint — streams documents, does not keep them all in memory ==="
    wait_for_app
    curl -sS "http://localhost:8080/good?limit=${LIMIT}"
    echo ""
    ;;

  options)
    ORG_ID="${ORG_ID:-org-alpha}"
    OPT_LIMIT="${OPT_LIMIT:-10}"
    echo ""
    echo "══════════════════════════════════════════════════════════════"
    echo " Aggregation Options — The withOptions() Trap (Spring demo)"
    echo "══════════════════════════════════════════════════════════════"
    echo ""
    echo "  Four endpoints show how execution options are lost client-side"
    echo "  before they ever reach MongoDB:"
    echo ""
    echo "    1. /options/broken         withOptions() discarded (immutable API)"
    echo "    2. /options/fixed          options chained correctly"
    echo "    3. /options/maxtime-trap   1ms maxTime discarded — query still runs"
    echo "    4. /options/raw-driver-trap  toPipeline() sends stages only"
    echo ""
    echo "  Rebuilding app image..."
    docker compose build app >/dev/null
    docker compose up -d --no-deps app >/dev/null
    wait_for_options_endpoint
    echo ""
    curl -sS "http://localhost:8080/options/broken?orgId=${ORG_ID}&limit=${OPT_LIMIT}"
    echo ""
    echo ""
    curl -sS "http://localhost:8080/options/fixed?orgId=${ORG_ID}&limit=${OPT_LIMIT}"
    echo ""
    echo ""
    curl -sS "http://localhost:8080/options/maxtime-trap?orgId=${ORG_ID}&limit=${OPT_LIMIT}"
    echo ""
    echo ""
    curl -sS "http://localhost:8080/options/raw-driver-trap?orgId=${ORG_ID}&limit=${OPT_LIMIT}"
    echo ""
    echo ""
    echo "  Full reference: AGGREGATION-OPTIONS-TECHNICAL-REFERENCE.md"
    echo ""
    ;;

  stop)
    docker compose down
    echo "Stopped. Data is still in the Docker volume — ./start.sh brings it back."
    ;;

  reset)
    echo "This deletes all demo data and runs setup again."
    read -r -p "Continue? [y/N] " ans
    if [[ "${ans,,}" != "y" ]]; then
      echo "Cancelled."
      exit 0
    fi
    docker compose down -v
    exec ./setup.sh
    ;;

  -h|--help|"")
    usage
    ;;

  *)
    echo "Unknown command: $1" >&2
    usage
    exit 1
    ;;
esac
