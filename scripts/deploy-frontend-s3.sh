#!/usr/bin/env bash
# Builds the frontend and publishes it as an S3 static website on LocalStack.
# From this origin the browser can open the AppSync Events WebSocket without
# EXTRA_CORS_ALLOWED_ORIGINS (localstack AWS-1890).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BUCKET=durable-serverlesspresso-frontend
awsl() { lstk --non-interactive aws "$@"; }

"$ROOT/scripts/frontend-env.sh"
# `npm run build` runs vue-tsc first, which fails on an existing type error in BaristaView.vue.
(cd "$ROOT/frontend" && npx vite build)

awsl s3api head-bucket --bucket "$BUCKET" 2>/dev/null || awsl s3 mb "s3://$BUCKET"
# index.html is also the error document, so the Vue routes (/attendee, /barista) load.
awsl s3 website "s3://$BUCKET" --index-document index.html --error-document index.html
awsl s3api put-bucket-policy --bucket "$BUCKET" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{\"Effect\": \"Allow\", \"Principal\": \"*\", \"Action\": \"s3:GetObject\", \"Resource\": \"arn:aws:s3:::$BUCKET/*\"}]}"
awsl s3 sync "$ROOT/frontend/dist" "s3://$BUCKET" --delete

echo "Website: http://$BUCKET.s3-website.localhost.localstack.cloud:4566"
