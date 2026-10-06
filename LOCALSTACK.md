# Running durable-serverlesspresso on LocalStack

Tested on 2026-09-23 with `localstack/localstack-pro:dev` (2026.9.0.dev341), lstk 1.0.1, SAM CLI 1.166.2 and Node.js 22.

## Quick start

```bash
lstk --config lstk.toml start
scripts/run-all.sh          # fresh deploy with 15 s timeouts, unit + integration + UI tests
```

Or step by step:

```bash
scripts/deploy-localstack.sh --fresh [--test-timeouts]
(cd src/coffee-orders && npx jest)          # Eric's unit tests (LocalDurableTestRunner)
(cd tests && npm test)                       # 15 integration tests against LocalStack
scripts/reset-demo.sh && scripts/deploy-frontend-s3.sh   # frontend on an S3 website
FRONTEND_URL=http://durable-serverlesspresso-frontend.s3-website.localhost.localstack.cloud:4566 \
  npx --prefix tests playwright test         # attendee orders, barista accepts and completes
scripts/demo-restart.sh                      # an order survives `lstk restart` (default timeouts)
```

`DEMO=1` runs the UI test headed and slowed down. Open the website URL above to use the app yourself.

The frontend can also run on the Vite dev server (`npm run dev` in `frontend/`, and the UI test without `FRONTEND_URL`). LocalStack only accepts the AppSync Events handshake from known origins, so for `http://localhost:5173` add `EXTRA_CORS_ALLOWED_ORIGINS = "http://localhost:5173"` to `lstk.toml` and restart.

## Retest on 2026.10.0.dev39 (2026-10-06)

The unmodified template now deploys natively (stack `durable-native`, no `Existing*` parameters), and every path passes on it: 5 unit tests, 15 integration tests, the UI test against the S3 website, and the restart demo followed by the UI test.

| Ticket | Status on this image |
|---|---|
| AWS-1881 AppSync Events in CloudFormation | Fixed. `Api`, `ApiKey` and `ChannelNamespace` deploy, outputs and namespace auth modes are correct. The `Existing*` workaround is no longer needed |
| AWS-1429 `AWS::Lambda::Alias` update | Fixed. A code change updates the alias in place (`Replacement: False`). `--fresh` is no longer needed |
| AWS-1883 `GetFunctionConfiguration` by alias | Fixed |
| AWS-1887 output URL rewrite | Fixed. The hardcoded `ApiUrl` output now resolves |
| AWS-1889 subscription IDs across connections | Fixed |
| AWS-1884 certificate SANs | Still open. Strict TLS to `*.appsync-api` and `*.appsync-realtime-api` fails with `ERR_TLS_CERT_ALTNAME_INVALID` |

The scripts take `STACK=<name>` to target another stack, for example `STACK=durable-native scripts/demo-restart.sh`.

## What this branch changes

| File | Change | Why |
|---|---|---|
| `template.yaml` | Optional `Existing*` parameters for the Events API, behind a condition. On AWS the stack still creates it | LocalStack CFN can't deploy `AWS::AppSync::Api` yet |
| `template.yaml`, `src/coffee-orders/index.ts` | `AcceptanceTimeoutSeconds` and `CompletionTimeoutSeconds`, default 120 | Tests run the timeout paths in 15 s |
| `src/coffee-orders/utils.ts`, `src/event-publisher/index.ts` | Pass `region` to `PublishRequest.signed` | The library reads the region from `*.appsync-api.<region>.amazonaws.com` and throws on any other host. It is correct on AWS too |
| `src/coffee-orders/package.json` | Pin `@aws/durable-execution-sdk-js-testing` to 1.1.1 | `^1.1.0` resolves to 1.1.4, which needs SDK 2.x, so the unit tests no longer loaded |
| `lstk.toml` | `:dev` image, persistence | |
| `scripts/deploy-frontend-s3.sh` | Builds the frontend and hosts it on an S3 website | Browsers can open the realtime socket from that origin with the default CORS settings (gap 5) |
| `scripts/`, `tests/` | Deploy, reset, demo scripts. Jest and Playwright suites | |

## LocalStack gaps

Already tracked from the workshop rebuild:

| Ticket | Gap | Here |
|---|---|---|
| AWS-1881 | CFN does not support `AWS::AppSync::Api` or `ChannelNamespace` | Blocks the deploy. Worked around with parameters |
| AWS-1429 | `AWS::Lambda::Alias` update fails, so every `AutoPublishAlias` redeploy fails | `--fresh` redeploys |
| AWS-1884 | TLS cert has no SAN for `*.appsync-realtime-api.localhost.localstack.cloud` | A normal browser can't open the realtime socket. Playwright ignores cert errors |
| AWS-1882 | Realtime not served on the HTTP host | Does not apply. This frontend builds the realtime host itself |

New in this run, filed in the AWS team triage queue:

1. **CFN outputs with `amazonaws.com` are rewritten into a broken host** (AWS-1887). Any output string containing `<region>.amazonaws.com` becomes `amazonaws.com:4566`, so `https://abc.execute-api.us-east-1.amazonaws.com/prod` turns into `https://abc.execute-api.amazonaws.com:4566/prod`, which does not resolve. Plain literals are affected too. Only `${AWS::URLSuffix}` gives a working URL. The template's `ApiUrl` output hits this. Repro: a stack with only outputs `!Sub 'https://abc.execute-api.${AWS::Region}.amazonaws.com/prod'` and the same string as a literal.
2. **API Gateway URLs fall through to S3 after a restart** (AWS-1888). With persistence on, after `lstk restart`, `https://<id>.execute-api.localhost.localstack.cloud:4566/prod/config/coffee-shop` returns S3 `NoSuchBucket` (bucket `prod`) until any API Gateway control-plane call loads the service. A web app used right after a restart gets 404s.
3. **AppSync Events realtime returns 404 after a restart** (AWS-1891). Same pattern: the WebSocket at `/event/realtime` returns 404 until any AppSync control-plane call. The HTTP publish endpoint was fine.

   Gaps 2 and 3 come from the default `SNAPSHOT_LOAD_STRATEGY=ON_REQUEST`, which restores a service only on its first control-plane call. `scripts/demo-restart.sh` makes one call to each service the app uses right after the restart.

   `ON_STARTUP` was tested as the alternative and is not used here:
   - It does fix both endpoints, but only once the restore has finished. `lstk restart` returns, `/_localstack/init` reports `READY` and `/_localstack/health` reports `persistence: initialized` about 20 s before that. Services restore one at a time, and only the `Ready.` log line marks the end.
   - During that window, services that are not restored yet behave as if empty. API Gateway answers 404, Lambda says "Function not found", and a PutEvents is accepted by an empty EventBridge store.
   - **That can lose state.** The `SCHEDULED` saver writes the empty store to disk before the restore reaches it, and the restore then loads the empty file. Repro: create a bus and a rule, wait for the save, `lstk restart`, send one PutEvents as soon as the endpoint answers. After `Ready.`, only the `default` bus is left. We lost every bus and rule of both stacks this way.

4. **AppSync Events subscription IDs are unique across all connections** (AWS-1889). A second connection that subscribes with an ID already used on another live connection gets `DuplicatedOperationError`. On AWS the ID only has to be unique within its connection. Clients with random IDs (this frontend, Amplify) are not affected.
5. **The AppSync Events WebSocket handshake is subject to LocalStack's CORS checks** (AWS-1890). From `http://localhost:5173` it returns 403 unless `EXTRA_CORS_ALLOWED_ORIGINS` includes the origin. This is intended: LocalStack cannot allow arbitrary local origins, but it does allow origins it serves itself. Hosting the frontend on an S3 website (`scripts/deploy-frontend-s3.sh`) works with the default settings: the handshake from `http://` and `https://<bucket>.s3-website.localhost.localstack.cloud:4566` opens, and the UI test passes with realtime updates. The same test from `localhost:5173` gets no realtime events.

Durable functions themselves had no issues: parallel branches, retries, `waitForCallback` with timeouts, callback success from another Lambda, execution history with `IncludeExecutionData`, `list-durable-executions-by-function` with status filters, stop, and resuming after a restart.

## Issues in the sample itself

These behave the same on AWS. They are worth raising with the author.

1. **Unknown event reports the wrong reason.** `validationResults.getResults()` skips branches that returned `undefined`, so for an unknown event `results[0]` is the order list and the order is cancelled with "Store is currently closed". Reading `validationResults.all[0].result` keeps the positions.
2. **The daily limit is off by one.** `initialize-order` writes the new order before the check, so it counts itself and the third order is rejected with `maxOrdersPerAttendee: 3`.
3. **Fast barista actions are lost.** `ORDER_QUEUED` and `ORDER_ACCEPTED` go out before the next callback is registered. An accept or complete that arrives in between finds no callback ID. The callback handler returns 400 to EventBridge, which treats it as delivered, and the action is gone. People are rarely that fast. The UI test waits for the phase in DynamoDB.
4. **`ApiUrl` hardcodes `amazonaws.com`.** Using `${AWS::URLSuffix}` would work on both AWS and LocalStack.
5. **`npm run build` fails.** `vue-tsc` reports `BaristaView.vue(396,30): error TS2365` before Vite runs. `scripts/deploy-frontend-s3.sh` calls `vite build` directly.
6. **`GET /orders/count` always returns 0.** The template matches `createdAt` (ISO) against `$context.requestTime.substring(0,10)`, but `requestTime` is `dd/MMM/yyyy:HH:mm:ss +0000`. An older LocalStack image returned 1 here, which hid the bug.
7. **The attendee view is event-wide.** It lists the event's 30 latest orders and treats the first pending one as the user's order. Two tabs of one browser profile also share state through localStorage. The UI test uses one browser context per role.
