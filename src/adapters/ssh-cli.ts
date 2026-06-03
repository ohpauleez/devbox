import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";

import { makeError, type DevboxError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { runProcess } from "./process.js";

const TEMP_KEY_PATH = "~/.ssh/ssm-ssh-tmp";
const TEMP_KEY_PUBLIC_PATH = "~/.ssh/ssm-ssh-tmp.pub";

export interface SshContext {
  readonly instanceId: string;
  readonly sshUser: string;
}

export interface StagedKey {
  readonly privateKeyPath: string;
  readonly publicKeyPath: string;
  readonly fromAgent: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function ssmProxyCommand(instanceId: string): string {
  return `aws ssm start-session --target ${instanceId} --document-name AWS-StartSSHSession --parameters portNumber=%p`;
}

/**
 * Ensure local source is a readable regular file.
 */
export async function validateLocalRegularFile(filePath: string): Promise<Result<void, DevboxError>> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return err(makeError("ValidationError", `local path is not a regular file: ${filePath}`));
    }
    return ok(undefined);
  } catch (error: unknown) {
    return err(makeError("ValidationError", `local file is not readable: ${filePath}`, [`${error}`]));
  }
}

/**
 * Select SSH key source from agent or temporary key generation.
 */
export async function ensureSshKeyMaterial(): Promise<Result<StagedKey, DevboxError>> {
  const agentResult = await runProcess("ssh-add", ["-l"]);
  if (agentResult.ok) {
    return ok({
      privateKeyPath: "",
      publicKeyPath: "",
      fromAgent: true,
    });
  }

  const keygenResult = await runProcess("ssh-keygen", [
    "-t",
    "rsa",
    "-N",
    "",
    "-f",
    TEMP_KEY_PATH,
    "-C",
    "ssh-over-ssm",
  ]);
  if (!keygenResult.ok) {
    if (keygenResult.error.category === "DependencyError") {
      return keygenResult;
    }
    return err(makeError("TransportError", "failed to generate temporary ssh key", keygenResult.error.details));
  }

  return ok({
    privateKeyPath: TEMP_KEY_PATH,
    publicKeyPath: TEMP_KEY_PUBLIC_PATH,
    fromAgent: false,
  });
}

/**
 * Stage temporary SSH authorization through AWS SSM.
 */
export async function stageTemporarySshKey(
  context: SshContext,
  key: StagedKey,
): Promise<Result<void, DevboxError>> {
  const keySourcePath = key.fromAgent ? "$(ssh-add -L | head -n1)" : `$(cat ${shellQuote(key.publicKeyPath)})`;

  const remoteCommand = [
    "set -eu",
    "umask 077",
    "mkdir -p ~/.ssh",
    `touch ~/.ssh/authorized_keys`,
    `chmod 600 ~/.ssh/authorized_keys`,
    `PUB=${keySourcePath}`,
    "grep -F \"$PUB\" ~/.ssh/authorized_keys >/dev/null 2>&1 || printf '%s\\n' \"$PUB\" >> ~/.ssh/authorized_keys",
    "(sleep 15; grep -v -F \"$PUB\" ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.tmp && mv ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys) >/dev/null 2>&1 &",
  ].join("; ");

  const result = await runProcess("aws", [
    "ssm",
    "send-command",
    "--instance-ids",
    context.instanceId,
    "--document-name",
    "AWS-RunShellScript",
    "--comment",
    "devbox temporary ssh key staging",
    "--parameters",
    `commands=${remoteCommand}`,
    "--output",
    "json",
  ]);

  if (!result.ok) {
    if (result.error.category === "DependencyError") {
      return result;
    }
    return err(makeError("TransportError", "failed to stage temporary SSH key", result.error.details));
  }
  return ok(undefined);
}

function commonSshArgs(context: SshContext, key: StagedKey): string[] {
  const args = [
    "-o",
    `ProxyCommand=${ssmProxyCommand(context.instanceId)}`,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
  ];
  if (!key.fromAgent) {
    args.push("-i", key.privateKeyPath, "-o", "IdentitiesOnly=yes");
  }
  return args;
}

/**
 * Start interactive SSH session over SSM proxy.
 */
export async function startInteractiveSsh(
  context: SshContext,
  key: StagedKey,
): Promise<Result<number, DevboxError>> {
  const args = [
    ...commonSshArgs(context, key),
    `${context.sshUser}@${context.instanceId}`,
  ];

  return await new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: "inherit" });
    child.on("error", (error) => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        resolve(err(makeError("DependencyError", "required executable not found: ssh")));
        return;
      }
      resolve(err(makeError("TransportError", "failed to start ssh session", [`${error}`])));
    });
    child.on("close", (code, signal) => {
      if (typeof code === "number") {
        resolve(ok(code));
        return;
      }
      resolve(err(makeError("TransportError", `ssh session terminated by signal: ${signal ?? "unknown"}`)));
    });
  });
}

/**
 * Upload file to remote temp path with SCP over SSM proxy.
 */
export async function uploadFileOverScp(
  context: SshContext,
  key: StagedKey,
  localPath: string,
): Promise<Result<string, DevboxError>> {
  const remoteTempPath = `/tmp/devbox-upload-${randomUUID()}-${basename(localPath)}`;
  const target = `${context.sshUser}@${context.instanceId}:${remoteTempPath}`;
  const result = await runProcess("scp", [
    ...commonSshArgs(context, key),
    localPath,
    target,
  ]);
  if (!result.ok) {
    if (result.error.category === "DependencyError") {
      return result;
    }
    return err(makeError("TransportError", "scp upload failed", result.error.details));
  }
  return ok(remoteTempPath);
}

/**
 * Finalize remote file with atomic mv after successful upload.
 */
export async function finalizeRemoteFile(
  context: SshContext,
  key: StagedKey,
  tempPath: string,
  finalPath: string,
): Promise<Result<void, DevboxError>> {
  const finalDir = dirname(finalPath);
  const command = `set -eu; mkdir -p ${shellQuote(finalDir)}; mv ${shellQuote(tempPath)} ${shellQuote(finalPath)}`;
  const result = await runProcess("ssh", [
    ...commonSshArgs(context, key),
    `${context.sshUser}@${context.instanceId}`,
    command,
  ]);
  if (!result.ok) {
    if (result.error.category === "DependencyError") {
      return result;
    }
    return err(makeError("TransportError", "remote file finalization failed", result.error.details));
  }
  return ok(undefined);
}

/**
 * Remove local temporary key files when temporary key path was used.
 */
export async function cleanupLocalTempKeys(key: StagedKey): Promise<void> {
  if (key.fromAgent) {
    return;
  }
  await runProcess("rm", ["-f", key.privateKeyPath, key.publicKeyPath]);
}
