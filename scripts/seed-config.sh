#!/usr/bin/env bash
# Seeds the event configuration the workflow validates against (README step 3): store open, 3 orders per attendee.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STACK=${STACK:-durable-serverlesspresso}
awsl() { lstk --non-interactive aws "$@"; }
CONFIG_TABLE=$(awsl cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='ConfigTableName'].OutputValue" --output text)
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
awsl dynamodb put-item --table-name "$CONFIG_TABLE" --item "{
  \"eventId\": {\"S\": \"coffee-shop\"}, \"eventName\": {\"S\": \"Coffee Shop\"},
  \"storeOpen\": {\"BOOL\": true}, \"maxOrdersPerAttendee\": {\"N\": \"3\"},
  \"createdAt\": {\"S\": \"$NOW\"}, \"updatedAt\": {\"S\": \"$NOW\"}}"
echo "Seeded event coffee-shop in $CONFIG_TABLE: store open, 3 orders per attendee"
