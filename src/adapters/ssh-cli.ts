/**
 * @module ssh-cli
 *
 * SSM-proxied SSH and SCP operations for remote instance access.
 *
 * This module provides the full lifecycle for SSH sessions tunneled through AWS SSM
 * Session Manager: key material provisioning, temporary key staging on the remote host,
 * interactive SSH, file upload via SCP, and cleanup. All SSH/SCP connections use the
 * `AWS-StartSSHSession` SSM document as a ProxyCommand, avoiding the need for direct
 * network connectivity to instances.
 *
 * @remarks
 * Signal handlers (SIGINT, SIGTERM) are registered on first use to ensure temporary
 * key files are cleaned up even if the process is interrupted. Handlers are registered
 * at most once per process lifetime (idempotent).
 *
 * Temporary keys are given a 15-second authorization window on the remote host,
 * after which a background process removes them from `authorized_keys`.
 *
 * @example
 * ```ts
 * import { ensureSshKeyMaterial, stageTemporarySshKey, startInteractiveSsh, cleanupLocalTempKeys } from "./adapters/ssh-cli.js";
 *
 * const key = await ensureSshKeyMaterial();
 * if (!key.ok) throw new Error(key.error.message);
 * await stageTemporarySshKey({ instanceId: "i-abc", sshUser: "ec2-user" }, key.value);
 * const code = await startInteractiveSsh({ instanceId: "i-abc", sshUser: "ec2-user" }, key.value);
 * await cleanupLocalTempKeys(key.value);
 * ```
 */

import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

import {
  makeTypedError,
  type RemoteTransportError,
  type ValidationError,
} from "../domain/errors.js";
import { assertNever } from "../domain/assert.js";
import { err, ok, type Result } from "../domain/result.js";
import { runProcess } from "./process.js";

/**
 * Generate a unique temporary key path to prevent multi-session collisions.
 * Each invocation gets its own key pair path under ~/.ssh/, incorporating both
 * PID and a random suffix to avoid conflicts across concurrent sessions.
 */
function makeTempKeyPath(): string {
  return join(homedir(), ".ssh", `ssm-ssh-tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
}

/**
 * Connection parameters for SSH/SCP operations over SSM.
 *
 * @remarks
 * The `instanceId` is used both as the SSM target and as the SSH hostname
 * (the ProxyCommand resolves it to a session tunnel).
 */
export interface SshContext {
  readonly instanceId: string;
  readonly sshUser: string;
}

/**
 * Describes staged SSH key material — either from a running ssh-agent or a generated temp pair.
 *
 * @remarks
 * When `fromAgent` is true, `privateKeyPath` and `publicKeyPath` are empty strings
 * (the agent provides keys transparently). When false, both paths reference temporary
 * files that must be cleaned up via {@link cleanupLocalTempKeys}.
 *
 * `publicKeyContent` always holds the actual public key string (e.g. "ssh-rsa AAAA... comment")
 * read from the local machine. This content is what gets staged on the remote host —
 * it must never be obtained remotely because neither the local agent nor local files
 * are accessible on the target instance.
 */
export interface StagedKey {
  readonly privateKeyPath: string;
  readonly publicKeyPath: string;
  readonly publicKeyContent: string;
  readonly fromAgent: boolean;
}

/**
 * Registry of pending temp key paths for signal-trapped cleanup.
 *
 * When the process receives SIGINT or SIGTERM during a session, all registered paths
 * are synchronously unlinked before re-raising the signal for default exit behavior.
 * This prevents key material from persisting on disk after interrupted sessions.
 */
const pendingCleanupPaths: Set<string> = new Set();
let signalHandlersRegistered = false;

/**
 * Register process-wide signal handlers for temp key cleanup.
 *
 * Handlers are registered at most once (idempotent). On SIGINT/SIGTERM, all
 * registered temp key paths are synchronously deleted, then the signal is
 * re-raised with default disposition to allow normal process termination.
 *
 * @remarks
 * Uses `unlinkSync` in signal handlers because async operations are unreliable
 * in signal context — the event loop may not get another tick.
 * Re-raises the signal after cleanup so the parent process sees the correct exit status.
 */
function registerSignalHandlers(): void {
  if (signalHandlersRegistered) {
    return;
  }
  signalHandlersRegistered = true;

  const cleanup = (signal: string): void => {
    for (const path of pendingCleanupPaths) {
      try {
        unlinkSync(path);
      } catch {
        // Best effort — file may already be removed.
      }
      try {
        unlinkSync(`${path}.pub`);
      } catch {
        // Best effort.
      }
    }
    pendingCleanupPaths.clear();
    // Re-raise signal with default disposition so the process exits with the correct status.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
}

/**
 * Register a temp key path for signal-based cleanup.
 */
function registerForCleanup(privateKeyPath: string): void {
  registerSignalHandlers();
  pendingCleanupPaths.add(privateKeyPath);
}

/**
 * Unregister a temp key path after normal cleanup completes.
 */
function unregisterFromCleanup(privateKeyPath: string): void {
  pendingCleanupPaths.delete(privateKeyPath);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function ssmProxyCommand(instanceId: string): string {
  return `aws ssm start-session --target ${instanceId} --document-name AWS-StartSSHSession --parameters portNumber=%p`;
}

/**
 * Validate that a local path references a readable regular file.
 *
 * @param filePath - Local filesystem path to validate. Must be non-empty.
 * @returns On success (`ok`): `undefined` — the path references an existing regular file.
 *   On error (`err`): `ValidationError` when the path does not exist, is not readable,
 *   or references a directory/symlink/device rather than a regular file.
 *
 * @remarks
 * Precondition: `filePath` is a non-empty path string.
 * Postcondition: on success, the path references an existing regular file accessible to the process.
 * Note: this does not guarantee the file remains accessible after the check (TOCTOU),
 * but subsequent SCP operations will fail clearly if the file disappears.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await validateLocalRegularFile("/path/to/upload.tar.gz");
 * if (!result.ok) {
 *   console.error(result.error.message); // "local path is not a regular file: ..."
 * }
 * ```
 */
export async function validateLocalRegularFile(filePath: string): Promise<Result<void, ValidationError>> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return err(makeTypedError("ValidationError", `local path is not a regular file: ${filePath}`));
    }
    return ok(undefined);
  } catch (error: unknown) {
    return err(makeTypedError("ValidationError", `local file is not readable: ${filePath}`, [`${error}`]));
  }
}

/**
 * Select SSH key source from a running ssh-agent or generate a unique temporary key pair.
 *
 * In both paths, the public key content is read locally and stored in the returned
 * `StagedKey.publicKeyContent`. This is critical: the key content must be available
 * as a string so it can be embedded literally in the remote staging command. Reading
 * the key on the remote host would fail because neither the local agent nor local
 * key files are accessible there.
 *
 * @returns On success (`ok`): a `StagedKey` describing available key material.
 *   When `fromAgent` is true, an ssh-agent with at least one loaded key was found
 *   and `publicKeyContent` holds the first public key from the agent.
 *   When `fromAgent` is false, a new RSA key pair was generated at unique temp paths,
 *   `publicKeyContent` holds the generated public key content, and the private key
 *   is registered for signal-based cleanup.
 *   On error (`err`): `DependencyError` when `ssh-keygen` is not found;
 *   `TransportError` when key generation or public key reading fails.
 *
 * @remarks
 * Precondition: either `ssh-add` or `ssh-keygen` must be available on `$PATH`.
 * Postcondition: on success, key material is available for SSH authentication and
 *   `publicKeyContent` is a non-empty string containing the public key.
 *   If a temp key was generated, it is registered for cleanup on SIGINT/SIGTERM.
 * Safety: uses unique per-invocation paths (PID + UUID) to prevent multi-session collisions.
 * Concurrency: safe to call concurrently; each call generates independent key paths.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const keyResult = await ensureSshKeyMaterial();
 * if (keyResult.ok) {
 *   // publicKeyContent is always available for remote staging
 *   console.log(`Public key: ${keyResult.value.publicKeyContent}`);
 *   if (keyResult.value.fromAgent) {
 *     console.log("Using ssh-agent keys");
 *   } else {
 *     console.log(`Generated temp key: ${keyResult.value.privateKeyPath}`);
 *   }
 * }
 * ```
 */
export async function ensureSshKeyMaterial(): Promise<Result<StagedKey, RemoteTransportError>> {
  const agentResult = await runProcess("ssh-add", ["-l"]);
  if (agentResult.ok) {
    // Agent has keys — read the actual public key content locally via `ssh-add -L`.
    // This must happen here because the remote host has no access to our local agent.
    const pubKeyResult = await runProcess("ssh-add", ["-L"]);
    if (!pubKeyResult.ok) {
      return err(makeTypedError("TransportError", "failed to read public key from ssh-agent"));
    }
    // Take the first key line; ssh-add -L outputs one key per line.
    const firstKey = pubKeyResult.value.stdout.split("\n")[0]?.trim() ?? "";
    if (firstKey.length === 0) {
      return err(makeTypedError("TransportError", "ssh-agent reported keys but produced no public key output"));
    }
    return ok({
      privateKeyPath: "",
      publicKeyPath: "",
      publicKeyContent: firstKey,
      fromAgent: true,
    });
  }

  const tempKeyPath = makeTempKeyPath();
  const tempKeyPublicPath = `${tempKeyPath}.pub`;

  const keygenResult = await runProcess("ssh-keygen", [
    "-t",
    "rsa",
    "-N",
    "",
    "-f",
    tempKeyPath,
    "-C",
    "ssh-over-ssm",
  ]);
  if (!keygenResult.ok) {
    switch (keygenResult.error.category) {
      case "DependencyError":
        return err(keygenResult.error);
      case "TransportError":
        break;
      default:
        return assertNever(keygenResult.error);
    }
    return err(makeTypedError("TransportError", "failed to generate temporary ssh key", keygenResult.error.details));
  }

  // Read the generated public key content from disk before returning.
  // This content will be embedded literally in the remote staging command.
  let publicKeyContent: string;
  try {
    publicKeyContent = (await readFile(tempKeyPublicPath, "utf8")).trim();
  } catch {
    return err(makeTypedError("TransportError", "failed to read generated public key file"));
  }

  if (publicKeyContent.length === 0) {
    return err(makeTypedError("TransportError", "generated public key file is empty"));
  }

  // Register for signal-based cleanup before returning, so interrupted sessions
  // don't leave key material on disk.
  registerForCleanup(tempKeyPath);

  return ok({
    privateKeyPath: tempKeyPath,
    publicKeyPath: tempKeyPublicPath,
    publicKeyContent,
    fromAgent: false,
  });
}

/**
 * Stage temporary SSH public key authorization on the remote instance via AWS SSM send-command.
 *
 * @param context - SSH connection context (instance id and user).
 * @param key - Staged key material to authorize on the remote host. The `publicKeyContent`
 *   field must contain the literal public key string (read locally by `ensureSshKeyMaterial`).
 * @returns On success (`ok`): `undefined` — the SSM command was dispatched.
 *   The key is appended to remote `~/.ssh/authorized_keys` and will auto-expire in 15 seconds.
 *   On error (`err`): `DependencyError` when AWS CLI is missing;
 *   `TransportError` on SSM dispatch failure.
 *
 * @remarks
 * Precondition: the instance is running and SSM agent is online.
 *   `key.publicKeyContent` must be a non-empty string containing the public key.
 * Postcondition: on success, the public key is appended to remote `~/.ssh/authorized_keys`.
 *   A background process on the remote host removes it after 15 seconds.
 *
 * ## Remote authorized_keys flow
 *
 * The SSM command executes the following sequence on the remote host:
 * 1. Ensure `~/.ssh/` exists with mode 0700 (umask 077 handles new files).
 * 2. Ensure `authorized_keys` exists with mode 0600.
 * 3. Set PUB to the literal public key content (embedded via single-quote shell escaping).
 * 4. Append the key only if not already present (idempotent via grep -F).
 * 5. Spawn a background process that sleeps 15 seconds then removes the key.
 *    This limits the authorization window — even if the SSH session never connects,
 *    the key doesn't persist indefinitely.
 *
 * The public key is embedded as a literal string in the remote command rather than
 * being obtained remotely (e.g. via `ssh-add -L`), because the local SSH agent and
 * local key files are not accessible on the remote host.
 *
 * The 15-second window is sufficient for SSH to complete the handshake.
 * If the connection takes longer to establish, the key may be removed before
 * authentication completes, causing connection failure.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await stageTemporarySshKey(
 *   { instanceId: "i-0123abc", sshUser: "ec2-user" },
 *   stagedKey,
 * );
 * if (!result.ok) {
 *   console.error(`Key staging failed: ${result.error.message}`);
 * }
 * ```
 */
export async function stageTemporarySshKey(
  context: SshContext,
  key: StagedKey,
): Promise<Result<void, RemoteTransportError>> {
  // Build the remote command that stages the public key in the SSH user's authorized_keys.
  // SSM RunShellScript executes as root, so we must resolve the target user's home
  // directory via getent passwd rather than relying on ~ (which would resolve to /root).
  const quotedUser = shellQuote(context.sshUser);
  const quotedKey = shellQuote(key.publicKeyContent);

  const remoteCommand = [
    "set -eu",
    // Resolve the target user's home directory from the system passwd database.
    // This works regardless of whether the user has a login shell or uses a custom home.
    `u=$(getent passwd ${quotedUser}) && x=$(echo $u | cut -d: -f6) || exit 1`,
    // Ensure ~/.ssh exists with correct ownership and mode.
    // install -d creates the directory only if missing, sets mode and owner atomically.
    `[ ! -d \${x}/.ssh ] && install -d -m700 -o${quotedUser} \${x}/.ssh`,
    "touch ${x}/.ssh/authorized_keys",
    `chmod 600 \${x}/.ssh/authorized_keys`,
    `chown ${quotedUser} \${x}/.ssh/authorized_keys`,
    // Embed the public key as a literal value using shellQuote (single-quote wrapping).
    // The key content was read locally by ensureSshKeyMaterial — the local agent and
    // local files are not accessible on the remote host.
    `PUB=${quotedKey}`,
    // Append only if not already present (idempotent).
    "grep -F \"$PUB\" ${x}/.ssh/authorized_keys >/dev/null 2>&1 && exit 0",
    "printf '%s\\n' \"$PUB\" >> ${x}/.ssh/authorized_keys",
    // Spawn bounded background cleanup: remove the key after 15 seconds.
    // This limits the authorization window even if the SSH session never connects.
    "(sleep 15; grep -v -F \"$PUB\" ${x}/.ssh/authorized_keys > ${x}/.ssh/authorized_keys.tmp && mv ${x}/.ssh/authorized_keys.tmp ${x}/.ssh/authorized_keys) >/dev/null 2>&1 &",
  ].join("; ");

  // Use JSON format for --parameters to avoid the AWS CLI shorthand parser,
  // which chokes on embedded quotes and commas in the shell script.
  // JSON encoding is unambiguous and avoids any injection risk since execFile
  // passes the argument directly without shell interpolation.
  const sendResult = await runProcess("aws", [
    "ssm",
    "send-command",
    "--instance-ids",
    context.instanceId,
    "--document-name",
    "AWS-RunShellScript",
    "--comment",
    "devbox temporary ssh key staging",
    "--parameters",
    JSON.stringify({ commands: [remoteCommand] }),
    "--output",
    "json",
  ]);

  if (!sendResult.ok) {
    switch (sendResult.error.category) {
      case "DependencyError":
        return err(sendResult.error);
      case "TransportError":
        break;
      default:
        return assertNever(sendResult.error);
    }
    return err(makeTypedError("TransportError", "failed to stage temporary SSH key", sendResult.error.details));
  }

  // Parse the CommandId from the send-command response so we can wait for execution.
  // send-command is asynchronous — without waiting, SSH may attempt to connect before
  // the key has been written to authorized_keys on the remote host.
  const commandId = extractCommandId(sendResult.value.stdout);
  if (commandId === undefined) {
    return err(makeTypedError("TransportError", "failed to parse command id from SSM send-command response"));
  }

  // Wait for the SSM command to finish executing on the remote host.
  // The built-in waiter polls every 5s for up to 25 attempts (~125s).
  // Key staging is a sub-second operation; if this times out something is wrong.
  const waitResult = await runProcess("aws", [
    "ssm",
    "wait",
    "command-executed",
    "--instance-id",
    context.instanceId,
    "--command-id",
    commandId,
  ]);

  if (!waitResult.ok) {
    switch (waitResult.error.category) {
      case "DependencyError":
        return err(waitResult.error);
      case "TransportError":
        break;
      default:
        return assertNever(waitResult.error);
    }
    return err(makeTypedError("TransportError", "SSH key staging command did not complete", waitResult.error.details));
  }

  return ok(undefined);
}

/**
 * Extract the CommandId from an `aws ssm send-command` JSON response.
 *
 * @param stdout - Raw JSON stdout from the send-command invocation.
 * @returns The CommandId string, or `undefined` if the response is malformed.
 *
 * @remarks
 * Precondition: `stdout` should be a JSON string from `aws ssm send-command --output json`.
 * Postcondition: returns a non-empty string CommandId, or undefined on any parse failure.
 * Safety: parses defensively — invalid JSON or missing fields produce undefined rather than
 * throwing, so the caller can report a clear TransportError.
 */
function extractCommandId(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const command = (parsed as Record<string, unknown>)["Command"];
    if (typeof command !== "object" || command === null) {
      return undefined;
    }
    const commandId = (command as Record<string, unknown>)["CommandId"];
    if (typeof commandId !== "string" || commandId.length === 0) {
      return undefined;
    }
    return commandId;
  } catch {
    return undefined;
  }
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
 * Start an interactive SSH session over the SSM session-manager proxy.
 *
 * @param context - SSH connection context (instance id and user).
 * @param key - Staged key material for authentication.
 * @param forwardAgent - When `true`, enable SSH agent forwarding (`-A`) for this
 *   session so remote processes can request signatures from the local agent.
 *   Defaults to `false` (no change from prior behavior). Callers are responsible
 *   for ensuring forwarding preconditions (a local agent with a loaded identity)
 *   were already validated — this function does not re-check them.
 * @returns On success (`ok`): the SSH process exit code (0 for clean exit).
 *   On error (`err`): `DependencyError` when `ssh` is not found on `$PATH`;
 *   `TransportError` on spawn failure or signal termination without an exit code.
 *
 * @remarks
 * Precondition: SSH key has been staged on the remote host; SSM proxy is reachable.
 * Postcondition: on success, the returned code is the SSH process exit status.
 * The child process inherits stdio (interactive terminal session).
 * Ownership: the caller is responsible for key cleanup after the session ends.
 * Agent forwarding is scoped to this function only — `commonSshArgs()` (shared
 * with {@link uploadFileOverScp} and {@link finalizeRemoteFile}) is never modified,
 * so `cp`'s transport is unaffected regardless of `forwardAgent`. If the remote
 * host's `sshd` refuses or ignores agent forwarding, the session still proceeds —
 * that condition is not detectable from the client side.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await startInteractiveSsh(
 *   { instanceId: "i-0123abc", sshUser: "ec2-user" },
 *   stagedKey,
 *   true,
 * );
 * if (result.ok && result.value !== 0) {
 *   console.error(`SSH exited with code ${result.value}`);
 * }
 * ```
 */
export async function startInteractiveSsh(
  context: SshContext,
  key: StagedKey,
  forwardAgent = false,
): Promise<Result<number, RemoteTransportError>> {
  const args = [
    ...commonSshArgs(context, key),
    ...(forwardAgent ? ["-A"] : []),
    `${context.sshUser}@${context.instanceId}`,
  ];

  return await new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: "inherit" });
    child.on("error", (error) => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        resolve(err(makeTypedError("DependencyError", "required executable not found: ssh")));
        return;
      }
      resolve(err(makeTypedError("TransportError", "failed to start ssh session", [`${error}`])));
    });
    child.on("close", (code, signal) => {
      if (typeof code === "number") {
        resolve(ok(code));
        return;
      }
      resolve(err(makeTypedError("TransportError", `ssh session terminated by signal: ${signal ?? "unknown"}`)));
    });
  });
}

/**
 * Upload a local file to a temporary remote path using SCP over the SSM proxy.
 *
 * @param context - SSH connection context (instance id and user).
 * @param key - Staged key material for authentication.
 * @param localPath - Validated local file path to upload (must pass {@link validateLocalRegularFile}).
 * @returns On success (`ok`): the remote temporary file path (`/tmp/devbox-upload-*`).
 *   On error (`err`): `DependencyError` when `scp` is not found;
 *   `TransportError` on transfer failure.
 *
 * @remarks
 * Precondition: `localPath` has been validated as a readable regular file; SSH key is staged.
 * Postcondition: on success, file contents exist at the returned `/tmp/devbox-upload-*` path.
 * The remote temp file has a UUID in its name to prevent collisions across uploads.
 * The caller should use {@link finalizeRemoteFile} to move it to the final destination.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await uploadFileOverScp(
 *   { instanceId: "i-0123abc", sshUser: "ec2-user" },
 *   stagedKey,
 *   "/local/path/config.yaml",
 * );
 * if (result.ok) {
 *   console.log(`Uploaded to: ${result.value}`);
 * }
 * ```
 */
export async function uploadFileOverScp(
  context: SshContext,
  key: StagedKey,
  localPath: string,
): Promise<Result<string, RemoteTransportError>> {
  const remoteTempPath = `/tmp/devbox-upload-${randomUUID()}-${basename(localPath)}`;
  const target = `${context.sshUser}@${context.instanceId}:${remoteTempPath}`;
  const result = await runProcess("scp", [
    ...commonSshArgs(context, key),
    localPath,
    target,
  ]);
  if (!result.ok) {
    switch (result.error.category) {
      case "DependencyError":
        return err(result.error);
      case "TransportError":
        break;
      default:
        return assertNever(result.error);
    }
    return err(makeTypedError("TransportError", "scp upload failed", result.error.details));
  }
  return ok(remoteTempPath);
}

/**
 * Finalize a remote file by atomically moving it from a temp path to the final destination.
 *
 * @param context - SSH connection context (instance id and user).
 * @param key - Staged key material for authentication.
 * @param tempPath - Remote temporary file path from a prior {@link uploadFileOverScp} call.
 * @param finalPath - Desired final remote destination path.
 * @returns On success (`ok`): `undefined` — the file is at `finalPath` and `tempPath` no longer exists.
 *   On error (`err`): `DependencyError` when `ssh` is not found;
 *   `TransportError` on remote command failure (e.g., permission denied, disk full).
 *
 * @remarks
 * Precondition: `tempPath` exists on the remote host; SSH key is staged.
 * Postcondition: on success, `finalPath` contains the uploaded content and `tempPath` no longer exists.
 * The remote directory structure is created if needed (`mkdir -p`).
 * Uses `mv` which is atomic on the same filesystem (typically the case within `/tmp` → final path
 * only if same mount; cross-filesystem moves are non-atomic).
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await finalizeRemoteFile(
 *   { instanceId: "i-0123abc", sshUser: "ec2-user" },
 *   stagedKey,
 *   "/tmp/devbox-upload-abc-config.yaml",
 *   "/home/ec2-user/app/config.yaml",
 * );
 * ```
 */
export async function finalizeRemoteFile(
  context: SshContext,
  key: StagedKey,
  tempPath: string,
  finalPath: string,
): Promise<Result<void, RemoteTransportError>> {
  const finalDir = dirname(finalPath);
  const command = `set -eu; mkdir -p ${shellQuote(finalDir)}; mv ${shellQuote(tempPath)} ${shellQuote(finalPath)}`;
  const result = await runProcess("ssh", [
    ...commonSshArgs(context, key),
    `${context.sshUser}@${context.instanceId}`,
    command,
  ]);
  if (!result.ok) {
    switch (result.error.category) {
      case "DependencyError":
        return err(result.error);
      case "TransportError":
        break;
      default:
        return assertNever(result.error);
    }
    return err(makeTypedError("TransportError", "remote file finalization failed", result.error.details));
  }
  return ok(undefined);
}

/**
 * Remove local temporary key files when a generated key pair was used.
 *
 * @param key - Staged key material. Cleanup is skipped when `fromAgent` is true
 *   (no temp files were created).
 *
 * @remarks
 * Precondition: none (safe to call unconditionally regardless of key source).
 * Postcondition: temporary key files are removed on a best-effort basis.
 *   The key path is unregistered from signal-based cleanup to avoid double-deletion.
 * Safety: failures are silently ignored to avoid masking prior errors in finally blocks.
 * Idempotent: safe to call multiple times for the same key.
 *
 * @example
 * ```ts
 * const key = (await ensureSshKeyMaterial()).value;
 * try {
 *   // ... use key for SSH operations ...
 * } finally {
 *   await cleanupLocalTempKeys(key);
 * }
 * ```
 */
export async function cleanupLocalTempKeys(key: StagedKey): Promise<void> {
  if (key.fromAgent) {
    return;
  }
  // Unregister from signal cleanup since we're doing normal cleanup now.
  // This prevents the signal handler from attempting to delete already-removed files.
  unregisterFromCleanup(key.privateKeyPath);

  try {
    await unlink(key.privateKeyPath);
  } catch {
    // Best effort — file may already be removed.
  }
  try {
    await unlink(key.publicKeyPath);
  } catch {
    // Best effort.
  }
}
