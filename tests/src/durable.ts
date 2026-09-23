import {
  GetDurableExecutionCommand,
  GetDurableExecutionHistoryCommand,
  GetFunctionConfigurationCommand,
  ListDurableExecutionsByFunctionCommand,
  StopDurableExecutionCommand,
  Event,
} from '@aws-sdk/client-lambda';
import { lambda, stack } from './stack';

export async function poll<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs = 30000, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * The API starts executions with an async invoke of the live alias, without an execution name.
 * Find the execution by the orderId in its input, like the get-execution-history function does.
 */
export async function executionForOrder(orderId: string) {
  const { functionName } = await stack();
  return poll(async () => {
    const list = await lambda.send(new ListDurableExecutionsByFunctionCommand({ FunctionName: functionName }));
    for (const e of list.DurableExecutions ?? []) {
      const full = await lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: e.DurableExecutionArn }));
      const input = JSON.parse(full.InputPayload ?? '{}');
      if (input.orderId === orderId) return full;
    }
    return undefined;
  }, `durable execution for order ${orderId}`);
}

export async function waitForStatus(arn: string, status: string, timeoutMs = 30000) {
  return poll(async () => {
    const res = await lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: arn }));
    return res.Status === status ? res : undefined;
  }, `execution status ${status}`, timeoutMs);
}

export async function history(arn: string): Promise<Event[]> {
  const events: Event[] = [];
  let marker: string | undefined;
  do {
    const res = await lambda.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: arn, Marker: marker }));
    events.push(...(res.Events ?? []));
    marker = res.NextMarker;
  } while (marker);
  return events;
}

export async function succeededSteps(arn: string): Promise<string[]> {
  return (await history(arn)).filter((e) => e.EventType === 'StepSucceeded' && e.Name).map((e) => e.Name!);
}

/** Reads the barista timeouts the stack was deployed with (defaults 120 s). */
export async function configuredTimeouts() {
  const { functionName } = await stack();
  const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  const vars = cfg.Environment?.Variables ?? {};
  return {
    acceptance: Number(vars.ACCEPTANCE_TIMEOUT_SECONDS ?? 120),
    completion: Number(vars.COMPLETION_TIMEOUT_SECONDS ?? 120),
  };
}

/** Stops executions still waiting for a barista, so their timers don't fire during later tests. */
export async function stopAllRunning() {
  const { functionName } = await stack();
  const res = await lambda.send(new ListDurableExecutionsByFunctionCommand({ FunctionName: functionName }));
  for (const e of res.DurableExecutions ?? []) {
    if (e.Status === 'RUNNING') {
      await lambda.send(new StopDurableExecutionCommand({ DurableExecutionArn: e.DurableExecutionArn }));
    }
  }
}
