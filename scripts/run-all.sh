#!/usr/bin/env bash
# Full run: fresh deploy with 15 s barista timeouts, unit tests, integration tests, then the
# frontend on an S3 website and the UI smoke test against it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/deploy-localstack.sh" --fresh --test-timeouts
(cd "$ROOT/src/coffee-orders" && npx jest)
(cd "$ROOT/tests" && npm test)
"$ROOT/scripts/reset-demo.sh"
"$ROOT/scripts/deploy-frontend-s3.sh"
(cd "$ROOT/tests" && FRONTEND_URL=http://durable-serverlesspresso-frontend.s3-website.localhost.localstack.cloud:4566 npx playwright test)
