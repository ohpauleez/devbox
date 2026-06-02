import { DevboxError } from "../domain/errors.js";
import { runProcess } from "./process.js";

function proxyCommand(instanceId: string): string {
  return `aws ssm start-session --document-name AWS-StartSSHSession --parameters portNumber=%p --target ${instanceId}`;
}

function shQuote(input: string): string {
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}

export async function connectViaSsm(instanceId: string): Promise<void> {
  const args = [
    "-o",
    `ProxyCommand=${proxyCommand(instanceId)}`,
    instanceId,
  ];
  const res = await runProcess("ssh", args, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (res.code !== 0) {
    throw new DevboxError("TransportError", "SSH connection failed");
  }
}

export async function scpViaSsm(instanceId: string, localPath: string, remotePath: string): Promise<void> {
  const args = [
    "-o",
    `ProxyCommand=${proxyCommand(instanceId)}`,
    localPath,
    `${instanceId}:${remotePath}`,
  ];
  const res = await runProcess("scp", args);
  if (res.code !== 0) {
    throw new DevboxError("TransportError", "SCP upload failed", res.stderr.trim());
  }
}

export async function sshMoveAndCleanup(
  instanceId: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  const cmd = `mv -- ${shQuote(fromPath)} ${shQuote(toPath)}`;
  const args = ["-o", `ProxyCommand=${proxyCommand(instanceId)}`, instanceId, "sh", "-lc", cmd];
  const res = await runProcess("ssh", args);
  if (res.code !== 0) {
    await sshCleanup(instanceId, fromPath);
    throw new DevboxError("TransportError", "Remote finalize failed", res.stderr.trim());
  }
}

export async function sshCleanup(instanceId: string, tempPath: string): Promise<void> {
  const cmd = `rm -f -- ${shQuote(tempPath)}`;
  const args = ["-o", `ProxyCommand=${proxyCommand(instanceId)}`, instanceId, "sh", "-lc", cmd];
  await runProcess("ssh", args);
}
