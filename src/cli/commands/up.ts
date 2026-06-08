/**
 * @module up
 *
 * Implements the `up` command: start the current devbox instance or wait for it
 * to reach the "running" state if a start is already in progress.
 *
 * The command uses state-dependent branching:
 * - If the instance is stopped → submit a start request, then wait for "running".
 * - If the instance is stopping → wait for "stopped", submit a start request, then wait for "running".
 * - If the instance is pending → just wait for "running" (start already submitted).
 * - If the instance is running → no-op, return immediately.
 * - If the instance is in a terminal state → return `InstanceStateError`.
 *
 * This branching logic is delegated to `decideUpAction` which returns a decision
 * record indicating whether to submit a start and/or wait.
 *
 * @example
 * ```ts
 * const result = await runUpCommand();
 * if (result.ok) {
 *   console.log(`Instance ${result.value.stdoutLines[0]} is running`);
 * }
 * ```
 */

import { describeInstance, startInstance } from "../../adapters/aws-cli.js";
import { loadConfig } from "../../adapters/config-store.js";
import { resolveCurrentBox } from "../../domain/context.js";
import { waitForEc2TargetState, type DescribeInstanceFn } from "../../domain/ec2-wait.js";
import { decideUpAction } from "../../domain/instance-state.js";
import { err, ok } from "../../domain/result.js";
import { EC2_WAIT_TIMEOUT_MS, REAL_CLOCK } from "../../domain/wait-policy.js";
import type { CommandResult } from "../context.js";

const describeInstanceAdapter: DescribeInstanceFn = describeInstance;

/**
 * Start the current instance or wait until it reaches the running state.
 *
 * @returns On success: the instance ID in `stdoutLines[0]`, confirming the instance
 *   is now running (or was already running). On error: a typed {@link DevboxError}
 *   describing the failure.
 *
 * @throws Never throws — all failures are returned as `Result.err`.
 *
 * @remarks
 * Preconditions:
 * - A current box must be selected in the local config.
 * - The instance must exist in AWS and be in a startable state
 *   (stopped, stopping, pending, or running).
 *
 * Postconditions on success:
 * - The instance is in "running" state (confirmed via polling).
 * - The instance ID is returned for downstream use.
 *
 * Invariants:
 * - No start request is submitted if the instance is already running or pending.
 * - The wait is skipped if the instance is already in the target state.
 *
 * Failure forms:
 * - `ConfigError` — config file missing or malformed.
 * - `ValidationError` — no current box is set.
 * - `NotFoundError` — instance does not exist in AWS.
 * - `InstanceStateError` — instance is in a terminal state (terminated/shutting-down).
 * - `AwsCliError` / `DependencyError` — `start-instances` call failed.
 * - `TimeoutError` — instance did not reach "running" within the polling budget.
 *
 * Concurrency: safe to call multiple times; duplicate starts are idempotent in EC2.
 *
 * @example
 * ```ts
 * import { runUpCommand } from "./up.js";
 *
 * const result = await runUpCommand();
 * if (!result.ok) {
 *   console.error(`Failed to start: ${result.error.message}`);
 *   process.exit(1);
 * }
 * // Instance is confirmed running
 * ```
 */
export async function runUpCommand(): Promise<CommandResult> {
  const configResult = await loadConfig();
  if (!configResult.ok) {
    return err(configResult.error);
  }

  const currentResult = resolveCurrentBox(configResult.value);
  if (!currentResult.ok) {
    return err(currentResult.error);
  }

  // Fetch current instance state to determine which action (if any) is needed.
  const describeResult = await describeInstance(currentResult.value.box.instanceId);
  if (!describeResult.ok) {
    return err(describeResult.error);
  }

  // Delegate state-transition logic to the pure domain function.
  // Why: keeps side-effectful command code free of state-machine reasoning.
  const decision = decideUpAction(describeResult.value.state);
  if (!decision.ok) {
    return err(decision.error);
  }

  const commandStartedAtMs = REAL_CLOCK.nowMs();

  if (decision.value.waitForStoppedBeforeStart) {
    const stoppedResult = await waitForEc2TargetState(
      {
        instanceId: describeResult.value.instanceId,
        expectedState: "stopped",
        timeoutMs: EC2_WAIT_TIMEOUT_MS,
      },
      describeInstanceAdapter,
    );
    if (!stoppedResult.ok) {
      return err(stoppedResult.error);
    }

    const elapsedMs = REAL_CLOCK.nowMs() - commandStartedAtMs;
    const remainingTimeoutMs = EC2_WAIT_TIMEOUT_MS - elapsedMs;
    if (remainingTimeoutMs <= 0) {
      return err({
        category: "TimeoutError",
        message: `instance ${describeResult.value.instanceId} did not reach running within ${Math.floor(EC2_WAIT_TIMEOUT_MS / 1000)}s (last: stopped)`,
      });
    }

    const startResult = await startInstance(describeResult.value.instanceId);
    if (!startResult.ok) {
      return err(startResult.error);
    }

    const runningResult = await waitForEc2TargetState(
      {
        instanceId: describeResult.value.instanceId,
        expectedState: "running",
        timeoutMs: remainingTimeoutMs,
      },
      describeInstanceAdapter,
    );
    if (!runningResult.ok) {
      return err(runningResult.error);
    }

    return ok({
      stdoutLines: [describeResult.value.instanceId],
      stderrLines: [],
    });
  }

  // Only submit a start if the instance is in a state that requires it (e.g., stopped).
  if (decision.value.submitStart) {
    const startResult = await startInstance(describeResult.value.instanceId);
    if (!startResult.ok) {
      return err(startResult.error);
    }
  }

  // Wait for "running" only if the instance is not already there.
  if (decision.value.wait) {
    const waitResult = await waitForEc2TargetState({
      instanceId: describeResult.value.instanceId,
      expectedState: "running",
    }, describeInstanceAdapter);
    if (!waitResult.ok) {
      return err(waitResult.error);
    }
  }

  return ok({
    stdoutLines: [describeResult.value.instanceId],
    stderrLines: [],
  });
}
