import { describeInstance, startInstance } from "../../adapters/aws-cli.js";
import { loadConfig } from "../../adapters/config-store.js";
import { resolveCurrentBox } from "../../domain/context.js";
import { waitForEc2TargetState } from "../../domain/ec2-wait.js";
import { decideUpAction } from "../../domain/instance-state.js";
import { err, ok } from "../../domain/result.js";
import type { CommandResult } from "../context.js";

/**
 * Start current instance or wait until it is running.
 *
 * @returns targeted instance id on success
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

  const describeResult = await describeInstance(currentResult.value.box.instanceId);
  if (!describeResult.ok) {
    return err(describeResult.error);
  }

  const decision = decideUpAction(describeResult.value.state);
  if (!decision.ok) {
    return err(decision.error);
  }

  if (decision.value.submitStart) {
    const startResult = await startInstance(describeResult.value.instanceId);
    if (!startResult.ok) {
      return err(startResult.error);
    }
  }

  if (decision.value.wait) {
    const waitResult = await waitForEc2TargetState({
      instanceId: describeResult.value.instanceId,
      expectedState: "running",
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
