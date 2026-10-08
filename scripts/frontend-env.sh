#!/usr/bin/env bash
# Writes frontend/.env with the LocalStack endpoints of the deployed stack.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STACK=${STACK:-durable-serverlesspresso}
awsl() { lstk --non-interactive aws "$@"; }
out() { awsl cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
# The ApiUrl output hardcodes amazonaws.com, so build the LocalStack URL from the REST API ID.
REST_API_ID=$(awsl cloudformation describe-stack-resource --stack-name "$STACK" \
  --logical-resource-id CoffeeOrderingApi --query StackResourceDetail.PhysicalResourceId --output text)
cat > "$ROOT/frontend/.env" <<ENV
VITE_API_BASE_URL=https://$REST_API_ID.execute-api.localhost.localstack.cloud:4566/prod
VITE_AWS_REGION=us-east-1
VITE_APPSYNC_EVENTS_URL=$(out AppSyncHttpEndpoint)
VITE_APPSYNC_EVENTS_API_KEY=$(out AppSyncApiKey)
VITE_EVENT_ID=coffee-shop
ENV
echo "Wrote frontend/.env"
