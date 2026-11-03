#!/usr/bin/env bash
# Run before every deploy ASK: unit tests, then build the real image, start it
# and hit /health. Catches files missing from the image (bit city-explorer 2026-10-06).
set -euo pipefail
cd "$(dirname "$0")/.."
node --test tests/parse.test.js tests/demo.test.js 2>&1 | grep -E "^ℹ (pass|fail)"
.venv/bin/python -m unittest discover -s tests 2>&1 | tail -1
docker build -q -t recs:predeploy . >/dev/null
docker rm -f recs-predeploy >/dev/null 2>&1 || true
docker run -d --name recs-predeploy -p 127.0.0.1:8798:8000 -e DB_PATH=/tmp/recs.db recs:predeploy >/dev/null
trap 'docker rm -f recs-predeploy >/dev/null 2>&1' EXIT
for _ in $(seq 20); do curl -fs localhost:8798/health >/dev/null 2>&1 && break; sleep 0.5; done
curl -fs localhost:8798/health && curl -fs -o /dev/null localhost:8798/ && echo " predeploy OK: $(git rev-parse --short HEAD)"
