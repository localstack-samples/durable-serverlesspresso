#!/usr/bin/env bash
# Demo: an order survives an emulator restart.
# 1. place an order and accept it, so the workflow waits for the barista to complete it
# 2. restart LocalStack (persistence is on in lstk.toml)
# 3. complete the order and show that the steps before the restart did not run again
# Needs the default 120 s barista timeouts (deploy without --test-timeouts).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK=durable-serverlesspresso
LSTK=(lstk --config "$ROOT/lstk.toml" --non-interactive)
awsl() { "${LSTK[@]}" aws "$@"; }
out() { awsl cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
REST_API_ID=$(awsl cloudformation describe-stack-resource --stack-name "$STACK" \
  --logical-resource-id CoffeeOrderingApi --query StackResourceDetail.PhysicalResourceId --output text)
API="https://$REST_API_ID.execute-api.localhost.localstack.cloud:4566/prod"
TABLE=$(out OrdersTableName)
FN=$(out DurableFunctionName)

phase() { awsl dynamodb get-item --table-name "$TABLE" --key "{\"orderId\":{\"S\":\"$1\"}}" --query 'Item.currentPhase.S' --output text; }
wait_phase() { for _ in $(seq 1 30); do [[ "$(phase "$1")" == "$2" ]] && return; sleep 1; done; echo "order never reached $2" >&2; exit 1; }

echo "==> Place an order and accept it"
ORDER_ID=$(curl -s -X POST "$API/orders" -H 'content-type: application/json' \
  -d '{"attendeeId":"restart-demo","eventId":"coffee-shop","orderDetails":{"drinkType":"Latte","size":"Medium"}}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["orderId"])')
wait_phase "$ORDER_ID" WAITING_ACCEPTANCE
curl -s -X POST "$API/barista/accept/$ORDER_ID" -H 'content-type: application/json' -d '{"baristaId":"barista-1"}' >/dev/null
wait_phase "$ORDER_ID" WAITING_COMPLETION
ARN=$(awsl lambda list-durable-executions-by-function --function-name "$FN" --statuses RUNNING \
  --query 'DurableExecutions[].DurableExecutionArn' --output text | tr '\t' '\n' | while read -r A; do
    awsl lambda get-durable-execution --durable-execution-arn "$A" --query InputPayload --output text | grep -q "$ORDER_ID" && echo "$A"; done)
echo "Order $ORDER_ID is waiting for the barista. Execution: $(awsl lambda get-durable-execution --durable-execution-arn "$ARN" --query Status --output text)"

echo "==> Restarting LocalStack"
"${LSTK[@]}" restart
# After a restart, API Gateway and AppSync Events endpoints only answer once their service
# has loaded (GAPS.md), so make one control-plane call to each.
awsl apigateway get-rest-apis --query 'length(items)' >/dev/null
awsl appsync list-apis --query 'length(apis)' >/dev/null

echo "==> Execution after the restart: $(awsl lambda get-durable-execution --durable-execution-arn "$ARN" --query Status --output text)"
echo "==> Barista completes the order"
curl -s -X POST "$API/barista/complete/$ORDER_ID" -H 'content-type: application/json' -d '{"baristaId":"barista-1"}'; echo
for _ in $(seq 1 60); do
  [[ "$(awsl lambda get-durable-execution --durable-execution-arn "$ARN" --query Status --output text)" != "RUNNING" ]] && break
  sleep 1
done
awsl lambda get-durable-execution --durable-execution-arn "$ARN" --query '{Status:Status}'
echo "==> initialize-order ran $(awsl lambda get-durable-execution-history --durable-execution-arn "$ARN" \
  --query "length(Events[?EventType=='StepStarted' && Name=='initialize-order'])") time(s)"
