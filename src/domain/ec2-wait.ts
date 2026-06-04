import type { InstanceDescription } from "../adapters/aws-cli.js";
import type { Ec2InstanceState } from "./instance-state.js";
import { makeError, type DevboxError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { EC2_POLL_INTERVAL_MS, EC2_WAIT_TIMEOUT_MS, SSM_POLL_INTERVAL_MS, SSM_WAIT_TIMEOUT_MS, REAL_CLOCK, type Clock } from "./wait-policy.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Adapter function signature for describing a single EC2 instance.
 *
 * @remarks
 * Injected to keep domain logic free of direct adapter imports.
 * Implementations must return the current instance description or an error.
 */
export type DescribeInstanceFn = (instanceId: string) => Promise<Result<InstanceDescription, DevboxError>>;

/**
 * Adapter function signature for querying SSM ping status.
 *
 * @remarks
 * Injected to keep domain logic free of direct adapter imports.
 * Returns "Online", "ConnectionLost", "Inactive", or undefined (not yet registered).
 */
export type DescribeSsmStatusFn = () => Promise<Result<"Online" | "ConnectionLost" | "Inactive" | undefined, DevboxError>>;

/**
 * Input for EC2 state polling.
 *
 * @remarks
 * `instanceId` must be non-empty. `expectedState` is the desired target.
 */
export interface WaitEc2TargetInput {
  readonly instanceId: string;
  readonly expectedState: "running" | "stopped";
}

/**
 * Success result from EC2 state polling.
 *
 * @remarks
 * `lastObservedState` will equal the requested `expectedState`.
 * `elapsedMs` is the wall-clock time spent polling.
 */
export interface WaitEc2TargetSuccess {
  readonly lastObservedState: Ec2InstanceState;
  readonly elapsedMs: number;
}

/**
 * Poll EC2 state until a target state is observed or timeout is reached.
 *
 * @param input - instance id and expected target state
 * @param describe - injected adapter for describing instance state
 * @param clock - optional clock for testability; defaults to real time
 * @returns last observed state and elapsed time on success; `TimeoutError` if bound exceeded;
 *   or adapter error propagated from `describe`
 *
 * @remarks
 * Precondition: `input.instanceId` is non-empty.
 * Postcondition on success: `lastObservedState === input.expectedState`.
 * Bound: polling terminates within `EC2_WAIT_TIMEOUT_MS` (5 minutes).
 * Performance: polls every `EC2_POLL_INTERVAL_MS` (5 seconds).
 * Concurrency: not safe for concurrent calls with the same instance — caller must serialize.
 * Ordering: each iteration awaits the previous describe call before sleeping.
 *
 * @example
 * ```ts
 * import { waitForEc2TargetState } from "./ec2-wait.js";
 *
 * const result = await waitForEc2TargetState(
 *   { instanceId: "i-abc123", expectedState: "running" },
 *   (id) => describeInstance(id),
 * );
 * if (result.ok) {
 *   console.log(`Reached running in ${result.value.elapsedMs}ms`);
 * }
 * ```
 */
export async function waitForEc2TargetState(
  input: WaitEc2TargetInput,
  describe: DescribeInstanceFn,
  clock: Clock = REAL_CLOCK,
): Promise<Result<WaitEc2TargetSuccess, DevboxError>> {
  const startedAtMs = clock.nowMs();
  let lastObservedState: Ec2InstanceState = "unknown";

  // Goal: poll until the instance reaches the expected state or time runs out.
  while (clock.nowMs() - startedAtMs <= EC2_WAIT_TIMEOUT_MS) {
    // Query current state from the adapter.
    const describeResult = await describe(input.instanceId);
    if (!describeResult.ok) {
      return describeResult;
    }
    lastObservedState = describeResult.value.state;
    // Check if target is reached — exit early on success.
    if (lastObservedState === input.expectedState) {
      return ok({
        lastObservedState,
        elapsedMs: clock.nowMs() - startedAtMs,
      });
    }
    // Sleep before next poll to avoid API throttling.
    await sleep(EC2_POLL_INTERVAL_MS);
  }

  return err(
    makeError(
      "TimeoutError",
      `instance ${input.instanceId} did not reach ${input.expectedState} within ${Math.floor(EC2_WAIT_TIMEOUT_MS / 1000)}s (last: ${lastObservedState})`,
    ),
  );
}

/**
 * Poll SSM readiness until online status is observed or timeout.
 *
 * @param getStatus - injected adapter for querying SSM ping status
 * @param clock - optional clock for testability; defaults to real time
 * @returns `ok(undefined)` when Online observed; `TimeoutError` if bound exceeded;
 *   or adapter error propagated from `getStatus`
 *
 * @remarks
 * Bound: polling terminates within `SSM_WAIT_TIMEOUT_MS` (2 minutes).
 * Performance: polls every `SSM_POLL_INTERVAL_MS` (5 seconds).
 * Concurrency: not safe for concurrent calls — caller must serialize.
 *
 * @example
 * ```ts
 * import { waitForSsmOnline } from "./ec2-wait.js";
 *
 * const result = await waitForSsmOnline(() => getSsmStatus(instanceId));
 * if (result.ok) {
 *   console.log("SSM is online, ready to connect");
 * }
 * ```
 */
export async function waitForSsmOnline(
  getStatus: DescribeSsmStatusFn,
  clock: Clock = REAL_CLOCK,
): Promise<Result<void, DevboxError>> {
  const startedAtMs = clock.nowMs();
  // Goal: poll until SSM reports "Online" or time runs out.
  while (clock.nowMs() - startedAtMs <= SSM_WAIT_TIMEOUT_MS) {
    const statusResult = await getStatus();
    if (!statusResult.ok) {
      return statusResult;
    }
    // "Online" means the SSM agent is ready to accept sessions.
    if (statusResult.value === "Online") {
      return ok(undefined);
    }
    // Sleep before next poll to avoid API throttling.
    await sleep(SSM_POLL_INTERVAL_MS);
  }

  return err(makeError("TimeoutError", "instance did not become SSM-ready within 120s"));
}
