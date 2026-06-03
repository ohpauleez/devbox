import { commitConfig, loadConfig } from "../../adapters/config-store.js";
import { describeInstance, describeSsmPingStatus } from "../../adapters/aws-cli.js";
import {
  cleanupLocalTempKeys,
  ensureSshKeyMaterial,
  stageTemporarySshKey,
  startInteractiveSsh,
  type SshContext,
} from "../../adapters/ssh-cli.js";
import { resolveCurrentBox } from "../../domain/context.js";
import { waitForSsmOnline } from "../../domain/ec2-wait.js";
import { makeError } from "../../domain/errors.js";
import { resolveSshUser } from "../../domain/ssh-user.js";
import { err, ok } from "../../domain/result.js";
import type { DevboxConfig } from "../../domain/types.js";
import type { CommandResult } from "../context.js";

/**
 * Start interactive remote connection for current box.
 *
 * @param invocationSshUser optional invocation-level SSH user override
 * @returns command output preserving SSH exit behavior contract
 */
export async function runConnectCommand(invocationSshUser?: string): Promise<CommandResult> {
  const configResult = await loadConfig();
  if (!configResult.ok) {
    return err(configResult.error);
  }

  const currentResult = resolveCurrentBox(configResult.value);
  if (!currentResult.ok) {
    return err(currentResult.error);
  }

  const sshUserResult = resolveSshUser({
    box: currentResult.value.box,
    defaults: configResult.value.defaults,
    ...(invocationSshUser !== undefined ? { invocationOverride: invocationSshUser } : {}),
  });
  if (!sshUserResult.ok) {
    return err(sshUserResult.error);
  }

  const instanceResult = await describeInstance(currentResult.value.box.instanceId);
  if (!instanceResult.ok) {
    return err(instanceResult.error);
  }
  if (instanceResult.value.state !== "running") {
    return err(makeError("InstanceStateError", `connect requires running instance (found ${instanceResult.value.state})`));
  }

  const ssmWaitResult = await waitForSsmOnline(() =>
    describeSsmPingStatus(instanceResult.value.instanceId),
  );
  if (!ssmWaitResult.ok) {
    return err(ssmWaitResult.error);
  }

  const keyResult = await ensureSshKeyMaterial();
  if (!keyResult.ok) {
    return err(keyResult.error);
  }

  const sshContext: SshContext = {
    instanceId: instanceResult.value.instanceId,
    sshUser: sshUserResult.value,
  };

  try {
    const stageResult = await stageTemporarySshKey(sshContext, keyResult.value);
    if (!stageResult.ok) {
      return err(stageResult.error);
    }

    const sshStartResult = await startInteractiveSsh(sshContext, keyResult.value);
    if (!sshStartResult.ok) {
      return err(sshStartResult.error);
    }

    const nextBoxes = {
      ...configResult.value.boxes,
      [currentResult.value.alias]: {
        ...currentResult.value.box,
        lastConnectAt: new Date().toISOString(),
      },
    };
    const nextConfig: DevboxConfig = {
      ...configResult.value,
      boxes: nextBoxes,
    };

    const commitResult = await commitConfig(nextConfig);
    if (!commitResult.ok) {
      return err(
        makeError(
          "ConsistencyError",
          "connect session started but lastConnectAt update failed",
          commitResult.error.details,
        ),
      );
    }

    return ok({
      stdoutLines: [],
      stderrLines: [],
      ...(sshStartResult.value === 0 ? {} : { exitCode: sshStartResult.value }),
    });
  } finally {
    await cleanupLocalTempKeys(keyResult.value);
  }
}
