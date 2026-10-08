#!/usr/bin/env bash
# Run after `lstk restart`. With the default SNAPSHOT_LOAD_STRATEGY (ON_REQUEST), a service restores
# its state on its first control-plane call, and until then its API Gateway and AppSync Events
# endpoints answer 404 (localstack AWS-1888, AWS-1891). This makes one call to each service the app uses.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
awsl() { lstk --non-interactive aws "$@" >/dev/null; }
awsl apigateway get-rest-apis
awsl appsync list-apis
awsl events list-event-buses
awsl lambda list-functions
awsl dynamodb list-tables
awsl s3api list-buckets
echo "Services restored: API Gateway, AppSync, EventBridge, Lambda, DynamoDB, S3"
