import { describeInstance } from "../adapters/aws-cli.js";
import type { Ec2InstanceState } from "./instance-state.js";
import { makeError, type DevboxError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { EC2_POLL_INTERVAL_MS, EC2_WAIT_TIMEOUT_MS, SSM_POLL_INTERVAL_MS, SSM_WAIT_TIMEOUT_MS } from "./wait-policy.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface WaitEc2TargetInput {
  readonly instanceId: string;
  readonly expectedState: "running" | "stopped";
}

export interface WaitEc2TargetSuccess {
  readonly lastObservedState: Ec2InstanceState;
  readonly elapsedMs: number;
}

/**
 * Poll EC2 state until a target state is observed or timeout is reached.
 */
export async function waitForEc2TargetState(
  input: WaitEc2TargetInput,
): Promise<Result<WaitEc2TargetSuccess, DevboxError>> {
  const startedAtMs = Date.now();
  let lastObservedState: Ec2InstanceState = "unknown";

  while (Date.now() - startedAtMs <= EC2_WAIT_TIMEOUT_MS) {
    const describeResult = await describeInstance(input.instanceId);
    if (!describeResult.ok) {
      return describeResult;
    }
    lastObservedState = describeResult.value.state;
    if (lastObservedState === input.expectedState) {
      return ok({
        lastObservedState,
        elapsedMs: Date.now() - startedAtMs,
      });
    }
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
 */
export async function waitForSsmOnline(
  getStatus: () => Promise<Result<"Online" | "ConnectionLost" | "Inactive" | undefined, DevboxError>>,
): Promise<Result<void, DevboxError>> {
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs <= SSM_WAIT_TIMEOUT_MS) {
    const statusResult = await getStatus();
    if (!statusResult.ok) {
      return statusResult;
    }
    if (statusResult.value === "Online") {
      return ok(undefined);
    }
    await sleep(SSM_POLL_INTERVAL_MS);
  }

  return err(makeError("TimeoutError", "instance did not become SSM-ready within 120s"));
}
