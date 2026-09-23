#!/usr/bin/env bash
# Full run: fresh deploy with 15 s barista timeouts, unit tests, integration tests, UI smoke test.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/deploy-localstack.sh" --fresh --test-timeouts
(cd "$ROOT/src/coffee-orders" && npx jest)
(cd "$ROOT/tests" && npm test)
"$ROOT/scripts/reset-demo.sh"
"$ROOT/scripts/frontend-env.sh"
(cd "$ROOT/tests" && npx playwright test)
