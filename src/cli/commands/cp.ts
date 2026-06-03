import { commitConfig, loadConfig } from "../../adapters/config-store.js";
import { describeInstance, describeSsmPingStatus } from "../../adapters/aws-cli.js";
import {
  cleanupLocalTempKeys,
  ensureSshKeyMaterial,
  finalizeRemoteFile,
  stageTemporarySshKey,
  uploadFileOverScp,
  validateLocalRegularFile,
  type SshContext,
} from "../../adapters/ssh-cli.js";
import { resolveCurrentBox } from "../../domain/context.js";
import { waitForSsmOnline } from "../../domain/ec2-wait.js";
import { makeError } from "../../domain/errors.js";
import { parseRemotePath } from "../../domain/remote-path.js";
import { resolveSshUser } from "../../domain/ssh-user.js";
import { err, ok } from "../../domain/result.js";
import type { DevboxConfig } from "../../domain/types.js";
import type { CommandResult } from "../context.js";

/**
 * Copy local file to remote path on current box.
 *
 * @param localPath local file path
 * @param remotePathRaw remote destination path
 * @param invocationSshUser optional invocation-level SSH user override
 * @returns command output or normalized failure
 */
export async function runCpCommand(
  localPath: string,
  remotePathRaw: string,
  invocationSshUser?: string,
): Promise<CommandResult> {
  const localValidation = await validateLocalRegularFile(localPath);
  if (!localValidation.ok) {
    return err(localValidation.error);
  }

  const remotePathResult = parseRemotePath(remotePathRaw);
  if (!remotePathResult.ok) {
    return err(remotePathResult.error);
  }

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

  const describeResult = await describeInstance(currentResult.value.box.instanceId);
  if (!describeResult.ok) {
    return err(describeResult.error);
  }
  if (describeResult.value.state !== "running") {
    return err(makeError("InstanceStateError", `cp requires running instance (found ${describeResult.value.state})`));
  }

  const ssmWaitResult = await waitForSsmOnline(() =>
    describeSsmPingStatus(describeResult.value.instanceId),
  );
  if (!ssmWaitResult.ok) {
    return err(ssmWaitResult.error);
  }

  const keyResult = await ensureSshKeyMaterial();
  if (!keyResult.ok) {
    return err(keyResult.error);
  }

  const sshContext: SshContext = {
    instanceId: describeResult.value.instanceId,
    sshUser: sshUserResult.value,
  };

  try {
    const stageResult = await stageTemporarySshKey(sshContext, keyResult.value);
    if (!stageResult.ok) {
      return err(stageResult.error);
    }

    const uploadResult = await uploadFileOverScp(
      sshContext,
      keyResult.value,
      localPath,
    );
    if (!uploadResult.ok) {
      return err(uploadResult.error);
    }

    const finalizeResult = await finalizeRemoteFile(
      sshContext,
      keyResult.value,
      uploadResult.value,
      remotePathResult.value,
    );
    if (!finalizeResult.ok) {
      return err(finalizeResult.error);
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
          "copy succeeded remotely but lastConnectAt update failed",
          commitResult.error.details,
        ),
      );
    }

    return ok({
      stdoutLines: [remotePathResult.value],
      stderrLines: [],
    });
  } finally {
    await cleanupLocalTempKeys(keyResult.value);
  }
}
