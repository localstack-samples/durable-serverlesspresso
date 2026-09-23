#!/usr/bin/env bash
# Deploys the stack to LocalStack with lstk.
# Usage: scripts/deploy-localstack.sh [--fresh] [--test-timeouts]
#   --fresh          delete the stack first. Stack updates fail on LocalStack today because of the
#                    AWS::Lambda::Alias update gap (localstack AWS-1429), so use this after code changes.
#   --test-timeouts  shorten the barista acceptance and completion timeouts to 15 s for the test suite
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK=durable-serverlesspresso
LSTK=(lstk --config "$ROOT/lstk.toml" --non-interactive)
awsl() { "${LSTK[@]}" aws "$@"; }

FRESH=false
TIMEOUTS=()
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=true ;;
    --test-timeouts) TIMEOUTS=(AcceptanceTimeoutSeconds=15 CompletionTimeoutSeconds=15) ;;
  esac
done

if $FRESH && awsl cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then
  awsl cloudformation delete-stack --stack-name "$STACK"
  awsl cloudformation wait stack-delete-complete --stack-name "$STACK"
fi

# AppSync Events API. LocalStack cannot deploy AWS::AppSync::Api from CloudFormation yet
# (localstack AWS-1881), so create it through the AppSync API with the template's settings.
API_ID=$(awsl appsync list-apis --query "apis[?name=='CoffeeOrderingEventsApi'].apiId | [0]" --output text)
if [[ "$API_ID" == "None" || -z "$API_ID" ]]; then
  API_ID=$(awsl appsync create-api --name CoffeeOrderingEventsApi \
    --event-config '{"authProviders":[{"authType":"API_KEY"},{"authType":"AWS_IAM"}],"connectionAuthModes":[{"authType":"API_KEY"}],"defaultPublishAuthModes":[{"authType":"AWS_IAM"}],"defaultSubscribeAuthModes":[{"authType":"API_KEY"}]}' \
    --query api.apiId --output text)
  awsl appsync create-channel-namespace --api-id "$API_ID" --name coffee-ordering \
    --publish-auth-modes authType=AWS_IAM --subscribe-auth-modes authType=API_KEY >/dev/null
  awsl appsync create-api-key --api-id "$API_ID" --description "API Key for Coffee Ordering Events API" >/dev/null
fi
# GetApi, because ListApis on LocalStack omits dns (localstack AWS-1885)
HTTP_DNS=$(awsl appsync get-api --api-id "$API_ID" --query 'api.dns.HTTP' --output text)
REALTIME_DNS=$(awsl appsync get-api --api-id "$API_ID" --query 'api.dns.REALTIME' --output text)
API_KEY=$(awsl appsync list-api-keys --api-id "$API_ID" --query 'apiKeys[0].id' --output text)
echo "AppSync Events API: $API_ID ($HTTP_DNS)"

cd "$ROOT"
"${LSTK[@]}" sam build
"${LSTK[@]}" sam deploy --stack-name "$STACK" --resolve-s3 --capabilities CAPABILITY_IAM \
  --no-confirm-changeset --no-fail-on-empty-changeset \
  --parameter-overrides ExistingEventsApiId="$API_ID" ExistingEventsApiHttpDns="$HTTP_DNS" \
    ExistingEventsApiRealtimeDns="$REALTIME_DNS" ExistingEventsApiKey="$API_KEY" ${TIMEOUTS[@]+"${TIMEOUTS[@]}"}

# Seed the config table (README step 3)
CONFIG_TABLE=$(awsl cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='ConfigTableName'].OutputValue" --output text)
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
awsl dynamodb put-item --table-name "$CONFIG_TABLE" --item "{
  \"eventId\": {\"S\": \"coffee-shop\"}, \"eventName\": {\"S\": \"Coffee Shop\"},
  \"storeOpen\": {\"BOOL\": true}, \"maxOrdersPerAttendee\": {\"N\": \"3\"},
  \"createdAt\": {\"S\": \"$NOW\"}, \"updatedAt\": {\"S\": \"$NOW\"}}"
echo "Deployed and seeded."
