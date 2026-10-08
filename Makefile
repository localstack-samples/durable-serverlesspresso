# Serverlesspresso with Lambda durable functions on LocalStack.
# Run `make` to list the targets. Each target prints the commands it runs.
# lstk reads .lstk/config.toml when it runs from this directory.

SHELL := /bin/bash
STACK ?= durable-serverlesspresso
FRONTEND_URL ?= http://durable-serverlesspresso-frontend.s3-website.localhost.localstack.cloud:4566
# Set TIMEOUTS=15 to shorten the barista acceptance and completion timeouts (default 120 s)
TIMEOUTS ?=

export STACK FRONTEND_URL
export STACK_NAME := $(STACK)

output = $(shell lstk --non-interactive aws cloudformation describe-stacks --stack-name $(STACK) --query "Stacks[0].Outputs[?OutputKey=='$(1)'].OutputValue" --output text)
FUNCTION = $(call output,DurableFunctionName)
LATEST_EXECUTION = $(shell lstk --non-interactive aws lambda list-durable-executions-by-function --function-name $(FUNCTION) --query 'sort_by(DurableExecutions,&StartTimestamp)[-1].DurableExecutionArn' --output text)

.DEFAULT_GOAL := help
.PHONY: help install start stop status build deploy frontend urls executions history \
        test-unit test test-ui test-all reset restart-demo destroy

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  make %-14s %s\n", $$1, $$2}'

install: ## Install the frontend and test dependencies
	cd frontend && npm install
	cd src/coffee-orders && npm install
	cd tests && npm install && npx playwright install chromium

start: ## Start LocalStack
	lstk start

stop: ## Stop LocalStack
	lstk stop

status: ## Show the emulator and the deployed resources
	lstk status

build: ## Build the Lambda functions with SAM
	lstk sam build

deploy: build ## Deploy the stack and open the coffee shop
	lstk sam deploy --stack-name $(STACK) --resolve-s3 --capabilities CAPABILITY_IAM --no-confirm-changeset --no-fail-on-empty-changeset$(if $(TIMEOUTS), --parameter-overrides AcceptanceTimeoutSeconds=$(TIMEOUTS) CompletionTimeoutSeconds=$(TIMEOUTS))
	scripts/seed-config.sh

frontend: ## Build the Vue frontend and host it on an S3 website
	scripts/deploy-frontend-s3.sh
	@$(MAKE) --no-print-directory urls

urls: ## Print the attendee and barista URLs
	@echo "Attendee: $(FRONTEND_URL)/attendee"
	@echo "Barista:  $(FRONTEND_URL)/barista"

executions: ## List the durable executions of the order workflow
	lstk aws lambda list-durable-executions-by-function --function-name $(FUNCTION) --query 'DurableExecutions[].[DurableExecutionName,Status]' --output table

history: ## Show the event history of the latest durable execution
	lstk aws lambda get-durable-execution-history --durable-execution-arn $(LATEST_EXECUTION) --query 'Events[].[EventType,Name]' --output table

test-unit: ## Run the unit tests (durable SDK test runner, no LocalStack needed)
	cd src/coffee-orders && npx jest

test: ## Run the integration tests against LocalStack
	cd tests && npm test

test-ui: reset ## Run the Playwright test against the S3 website
	cd tests && npx playwright test

test-all: ## Deploy with 15 s timeouts and run every test
	$(MAKE) deploy TIMEOUTS=15
	$(MAKE) frontend test-unit test test-ui

reset: ## Delete all orders and open the store
	scripts/reset-demo.sh

restart-demo: ## Show an order surviving `lstk restart` (needs the default timeouts)
	scripts/demo-restart.sh

destroy: ## Delete the stack
	lstk aws cloudformation delete-stack --stack-name $(STACK)
	lstk aws cloudformation wait stack-delete-complete --stack-name $(STACK)
