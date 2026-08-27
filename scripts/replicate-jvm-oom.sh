#!/usr/bin/env bash
# Legacy entry point — use the Docker flow instead (simpler, no Maven on host).

set -euo pipefail
cd "$(dirname "$0")/.."

cat <<'EOF'

This demo now runs fully in Docker. Use these three commands:

  ./setup.sh        # once before your session (~3–5 min)
  ./start.sh        # at session time (instant)
  ./demo.sh oom     # trigger JVM OOM
  ./demo.sh good    # show the fix

See README.md for details.

EOF

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  exit 0
fi

if [[ -x ./demo.sh ]]; then
  case "${1:-}" in
    oom|good|stop|reset) exec ./demo.sh "$@" ;;
    --fast) exec ./demo.sh oom ;;
    --http) exec ./demo.sh oom ;;
  esac
fi

exit 0
