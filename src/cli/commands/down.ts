/**
 * @module down
 *
 * Implements the `down` command: stop the current devbox instance or wait for it
 * to reach the "stopped" state if a stop is already in progress.
 *
 * Uses the same state-dependent branching pattern as `up`, delegating the
 * decision of whether to submit a stop and/or wait to `decideDownAction`.
 *
 * @example
 * ```ts
 * const result = await runDownCommand();
 * if (result.ok) {
 *   console.log(`Instance ${result.value.stdoutLines[0]} is stopped`);
 * }
 * ```
 */

import { describeInstance, stopInstance } from "../../adapters/aws-cli.js";
import { loadConfig } from "../../adapters/config-store.js";
import { resolveCurrentBox } from "../../domain/context.js";
import { waitForEc2TargetState, type DescribeInstanceFn } from "../../domain/ec2-wait.js";
import { decideDownAction } from "../../domain/instance-state.js";
import { err, ok } from "../../domain/result.js";
import type { CommandResult } from "../context.js";

const describeInstanceAdapter: DescribeInstanceFn = describeInstance;

/**
 * Stop the current instance or wait until it reaches the stopped state.
 *
 * @returns On success: the instance ID in `stdoutLines[0]`, confirming the instance
 *   is now stopped (or was already stopped). On error: a typed {@link DevboxError}
 *   describing the failure.
 *
 * @throws Never throws — all failures are returned as `Result.err`.
 *
 * @remarks
 * Preconditions:
 * - A current box must be selected in the local config.
 * - The instance must exist in AWS and be in a stoppable state
 *   (running, pending, stopping, or stopped).
 *
 * Postconditions on success:
 * - The instance is in "stopped" state (confirmed via polling).
 * - The instance ID is returned for downstream use.
 *
 * Invariants:
 * - No stop request is submitted if the instance is already stopped or stopping.
 * - The wait is skipped if the instance is already in the target state.
 *
 * Failure forms:
 * - `ConfigError` — config file missing or malformed.
 * - `ValidationError` — no current box is set.
 * - `NotFoundError` — instance does not exist in AWS.
 * - `InstanceStateError` — instance is in a terminal state (terminated/shutting-down).
 * - `AwsCliError` / `DependencyError` — `stop-instances` call failed.
 * - `TimeoutError` — instance did not reach "stopped" within the polling budget.
 *
 * Concurrency: safe to call multiple times; duplicate stops are idempotent in EC2.
 *
 * @example
 * ```ts
 * import { runDownCommand } from "./down.js";
 *
 * const result = await runDownCommand();
 * if (!result.ok) {
 *   console.error(`Failed to stop: ${result.error.message}`);
 *   process.exit(1);
 * }
 * ```
 */
export async function runDownCommand(): Promise<CommandResult> {
  const configResult = await loadConfig();
  if (!configResult.ok) {
    return err(configResult.error);
  }

  const currentResult = resolveCurrentBox(configResult.value);
  if (!currentResult.ok) {
    return err(currentResult.error);
  }

  const describeResult = await describeInstance(currentResult.value.box.instanceId);
  if (!describeResult.ok) {
    return err(describeResult.error);
  }

  // Delegate state-transition logic to the pure domain function.
  const decision = decideDownAction(describeResult.value.state);
  if (!decision.ok) {
    return err(decision.error);
  }

  // Only submit a stop if the instance is in a state that requires it (e.g., running).
  if (decision.value.submitStop) {
    const stopResult = await stopInstance(describeResult.value.instanceId);
    if (!stopResult.ok) {
      return err(stopResult.error);
    }
  }

  // Wait for "stopped" only if the instance is not already there.
  if (decision.value.wait) {
    const waitResult = await waitForEc2TargetState({
      instanceId: describeResult.value.instanceId,
      expectedState: "stopped",
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
