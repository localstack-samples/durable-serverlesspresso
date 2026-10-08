#!/usr/bin/env bash
# Stops running order workflows and deletes all orders, so the attendee and barista views start empty.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STACK=${STACK:-durable-serverlesspresso}
awsl() { lstk --non-interactive aws "$@"; }
out() { awsl cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

FN=$(out DurableFunctionName)
for ARN in $(awsl lambda list-durable-executions-by-function --function-name "$FN" \
    --query "DurableExecutions[?Status=='RUNNING'].DurableExecutionArn" --output text); do
  awsl lambda stop-durable-execution --durable-execution-arn "$ARN" >/dev/null
done

TABLE=$(out OrdersTableName)
for ID in $(awsl dynamodb scan --table-name "$TABLE" --projection-expression orderId --query 'Items[].orderId.S' --output text); do
  awsl dynamodb delete-item --table-name "$TABLE" --key "{\"orderId\":{\"S\":\"$ID\"}}"
done

CONFIG=$(out ConfigTableName)
awsl dynamodb update-item --table-name "$CONFIG" --key '{"eventId":{"S":"coffee-shop"}}' \
  --update-expression 'SET storeOpen = :t' --expression-attribute-values '{":t":{"BOOL":true}}'
echo "Orders cleared, store open."
