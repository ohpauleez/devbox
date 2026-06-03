import { describeInstance, stopInstance } from "../../adapters/aws-cli.js";
import { loadConfig } from "../../adapters/config-store.js";
import { resolveCurrentBox } from "../../domain/context.js";
import { waitForEc2TargetState } from "../../domain/ec2-wait.js";
import { decideDownAction } from "../../domain/instance-state.js";
import { err, ok } from "../../domain/result.js";
import type { CommandResult } from "../context.js";

/**
 * Stop current instance or wait until it is stopped.
 *
 * @returns targeted instance id on success
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

  const decision = decideDownAction(describeResult.value.state);
  if (!decision.ok) {
    return err(decision.error);
  }

  if (decision.value.submitStop) {
    const stopResult = await stopInstance(describeResult.value.instanceId);
    if (!stopResult.ok) {
      return err(stopResult.error);
    }
  }

  if (decision.value.wait) {
    const waitResult = await waitForEc2TargetState({
      instanceId: describeResult.value.instanceId,
      expectedState: "stopped",
    });
    if (!waitResult.ok) {
      return err(waitResult.error);
    }
  }

  return ok({
    stdoutLines: [describeResult.value.instanceId],
    stderrLines: [],
  });
}
