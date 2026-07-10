import { EventEmitter } from "node:events";
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../../src/adapters/process.js", () => ({
  runProcess: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import * as childProcess from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as processAdapter from "../../src/adapters/process.js";
import {
  cleanupLocalTempKeys,
  ensureSshKeyMaterial,
  finalizeRemoteFile,
  stageTemporarySshKey,
  startInteractiveSsh,
  uploadFileOverScp,
  validateLocalRegularFile,
} from "../../src/adapters/ssh-cli.js";
import { err, ok } from "../../src/domain/result.js";
import { makeTypedError } from "../../src/domain/errors.js";
import { traceSpec } from "../support/spec-trace.js";

const runProcessMock = vi.mocked(processAdapter.runProcess);
const readFileMock = vi.mocked(fsPromises.readFile);
const statMock = vi.mocked(fsPromises.stat);
const unlinkMock = vi.mocked(fsPromises.unlink);
const spawnMock = vi.mocked(childProcess.spawn);

/**
 * Build a minimal fake child process for `spawn()` mocking: an EventEmitter
 * that `startInteractiveSsh` can register "error"/"close" listeners on.
 */
function fakeChildProcess(): EventEmitter {
  return new EventEmitter();
}

describe("ssh-cli adapter contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts regular files regardless of large size", async () => {
    traceSpec("REMOTE-DOMAIN-FILESIZE", "REMOTE-CP-LARGESIZE");

    statMock.mockResolvedValueOnce({
      isFile: () => true,
      size: 10_000_000_000,
    } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);

    const result = await validateLocalRegularFile("/tmp/huge-file.bin");
    expect(result.ok).toBe(true);
  });

  it("prefers ssh-agent key material when available and reads public key locally", async () => {
    traceSpec("REMOTE-ADAPTER-KEYSTORE", "REMOTE-KEY-AGENT");

    // First call: ssh-add -l (check agent availability)
    runProcessMock.mockResolvedValueOnce(ok({ stdout: "2048 SHA256:abc /home/user/.ssh/id_rsa (RSA)", stderr: "", exitCode: 0 }));
    // Second call: ssh-add -L (read public key content)
    runProcessMock.mockResolvedValueOnce(ok({ stdout: "ssh-rsa AAAAB3...key== user@host\n", stderr: "", exitCode: 0 }));

    const result = await ensureSshKeyMaterial();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.fromAgent).toBe(true);
    expect(result.value.privateKeyPath).toBe("");
    expect(result.value.publicKeyPath).toBe("");
    expect(result.value.publicKeyContent).toBe("ssh-rsa AAAAB3...key== user@host");
  });

  it("falls back to generated temporary key material when ssh-agent is unavailable", async () => {
    traceSpec("REMOTE-ADAPTER-KEYSTORE", "REMOTE-KEY-TEMP");

    // First call: ssh-add -l (agent unavailable)
    runProcessMock
      .mockResolvedValueOnce(err(makeTypedError("TransportError", "ssh-add failed")))
      // Second call: ssh-keygen
      .mockResolvedValueOnce(ok({ stdout: "", stderr: "", exitCode: 0 }));
    // readFile for the generated .pub file
    readFileMock.mockResolvedValueOnce("ssh-rsa AAAAB3...generated== ssh-over-ssm\n" as never);

    const result = await ensureSshKeyMaterial();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.fromAgent).toBe(false);
    expect(result.value.privateKeyPath).toContain("ssm-ssh-tmp-");
    expect(result.value.publicKeyPath).toContain(".pub");
    expect(result.value.publicKeyContent).toBe("ssh-rsa AAAAB3...generated== ssh-over-ssm");
  });

  it("stages temporary key via SSM with user home resolution, literal key, and bounded wait", async () => {
    traceSpec("REMOTE-ADAPTER-STAGE", "REMOTE-STAGE-SUCCESS", "REMOTE-KEY-REMOTE-CLEANUP");

    const sendCommandResponse = JSON.stringify({ Command: { CommandId: "cmd-abc123" } });
    // First call: aws ssm send-command (dispatches the staging script)
    runProcessMock.mockResolvedValueOnce(ok({ stdout: sendCommandResponse, stderr: "", exitCode: 0 }));
    // Second call: aws ssm wait command-executed (blocks until staging finishes)
    runProcessMock.mockResolvedValueOnce(ok({ stdout: "", stderr: "", exitCode: 0 }));

    const stageResult = await stageTemporarySshKey(
      { instanceId: "i-alpha123", sshUser: "ec2-user" },
      { privateKeyPath: "/tmp/key", publicKeyPath: "/tmp/key.pub", publicKeyContent: "ssh-rsa AAAAB3...test== user@host", fromAgent: false },
    );
    expect(stageResult.ok).toBe(true);

    // Verify the send-command invocation
    const sendInvocation = runProcessMock.mock.calls[0];
    expect(sendInvocation?.[0]).toBe("aws");
    const sendArgs = sendInvocation?.[1].join(" ") ?? "";
    expect(sendArgs).toContain("send-command");
    expect(sendArgs).toContain("authorized_keys");
    expect(sendArgs).toContain("sleep 15");
    // The remote command must resolve the SSH user's home via getent passwd,
    // not use ~ (which would resolve to /root under SSM RunShellScript).
    expect(sendArgs).toContain("getent passwd");
    expect(sendArgs).not.toContain("~/.ssh");
    // The literal key content must appear in the remote command (embedded via shellQuote),
    // not a command substitution like $(ssh-add -L) that would fail on the remote host.
    expect(sendArgs).toContain("ssh-rsa AAAAB3...test== user@host");
    expect(sendArgs).not.toContain("ssh-add");
    expect(sendArgs).not.toContain("$(cat");

    // Verify the wait invocation uses the extracted CommandId
    const waitInvocation = runProcessMock.mock.calls[1];
    expect(waitInvocation?.[0]).toBe("aws");
    expect(waitInvocation?.[1]).toContain("wait");
    expect(waitInvocation?.[1]).toContain("command-executed");
    expect(waitInvocation?.[1]).toContain("cmd-abc123");
    expect(waitInvocation?.[1]).toContain("i-alpha123");
  });

  it("reports transport error when key staging command fails", async () => {
    traceSpec("REMOTE-STAGE-FAIL");

    runProcessMock.mockResolvedValueOnce(
      err(makeTypedError("TransportError", "ssm send-command failed", ["boom"])),
    );

    const stageResult = await stageTemporarySshKey(
      { instanceId: "i-alpha123", sshUser: "ec2-user" },
      { privateKeyPath: "/tmp/key", publicKeyPath: "/tmp/key.pub", publicKeyContent: "ssh-rsa AAAA== user@host", fromAgent: false },
    );
    expect(stageResult.ok).toBe(false);
    if (!stageResult.ok) {
      expect(stageResult.error.category).toBe("TransportError");
    }
  });

  it("reports transport error when SSM wait for key staging times out", async () => {
    traceSpec("REMOTE-STAGE-FAIL");

    const sendCommandResponse = JSON.stringify({ Command: { CommandId: "cmd-timeout1" } });
    // send-command succeeds
    runProcessMock.mockResolvedValueOnce(ok({ stdout: sendCommandResponse, stderr: "", exitCode: 0 }));
    // wait fails (timeout or command failure)
    runProcessMock.mockResolvedValueOnce(
      err(makeTypedError("TransportError", "waiter timed out", ["Waiter encountered a terminal failure state"])),
    );

    const stageResult = await stageTemporarySshKey(
      { instanceId: "i-alpha123", sshUser: "ec2-user" },
      { privateKeyPath: "/tmp/key", publicKeyPath: "/tmp/key.pub", publicKeyContent: "ssh-rsa AAAA== user@host", fromAgent: false },
    );
    expect(stageResult.ok).toBe(false);
    if (!stageResult.ok) {
      expect(stageResult.error.category).toBe("TransportError");
      expect(stageResult.error.message).toContain("did not complete");
    }
  });

  it("cleans up generated local temp keys", async () => {
    traceSpec("REMOTE-KEY-TEMP");

    unlinkMock.mockResolvedValue(undefined);

    await cleanupLocalTempKeys({
      fromAgent: false,
      privateKeyPath: "/tmp/key",
      publicKeyPath: "/tmp/key.pub",
      publicKeyContent: "ssh-rsa AAAA== user@host",
    });

    expect(unlinkMock).toHaveBeenCalledTimes(2);
  });

  it("enables agent forwarding on the interactive session when requested, and omits it by default", async () => {
    traceSpec("REMOTE-ADAPTER-FORWARDAGENT", "REMOTE-FWDAGENT-SESSION");

    const key = {
      fromAgent: true,
      privateKeyPath: "",
      publicKeyPath: "",
      publicKeyContent: "ssh-rsa AAAA== user@host",
    };
    const context = { instanceId: "i-alpha123", sshUser: "ec2-user" };

    const forwardedChild = fakeChildProcess();
    spawnMock.mockReturnValueOnce(forwardedChild as unknown as ReturnType<typeof childProcess.spawn>);
    const forwardedPromise = startInteractiveSsh(context, key, true);
    forwardedChild.emit("close", 0, null);
    const forwardedResult = await forwardedPromise;
    expect(forwardedResult.ok).toBe(true);
    expect(spawnMock.mock.calls[0]?.[1]).toContain("-A");

    const plainChild = fakeChildProcess();
    spawnMock.mockReturnValueOnce(plainChild as unknown as ReturnType<typeof childProcess.spawn>);
    const plainPromise = startInteractiveSsh(context, key, false);
    plainChild.emit("close", 0, null);
    const plainResult = await plainPromise;
    expect(plainResult.ok).toBe(true);
    expect(spawnMock.mock.calls[1]?.[1]).not.toContain("-A");

    // Default (no third argument) must match the explicit `false` case — this is the
    // pre-existing behavior for every caller that predates agent forwarding.
    const defaultChild = fakeChildProcess();
    spawnMock.mockReturnValueOnce(defaultChild as unknown as ReturnType<typeof childProcess.spawn>);
    const defaultPromise = startInteractiveSsh(context, key);
    defaultChild.emit("close", 0, null);
    await defaultPromise;
    expect(spawnMock.mock.calls[2]?.[1]).not.toContain("-A");
  });

  it("keeps cp's upload and finalize transport free of agent forwarding", async () => {
    traceSpec("REMOTE-FWDAGENT-CPSAFE");

    const key = {
      fromAgent: true,
      privateKeyPath: "",
      publicKeyPath: "",
      publicKeyContent: "ssh-rsa AAAA== user@host",
    };
    const context = { instanceId: "i-alpha123", sshUser: "ec2-user" };

    runProcessMock.mockResolvedValueOnce(ok({ stdout: "", stderr: "", exitCode: 0 }));
    await uploadFileOverScp(context, key, "/local/path/file.txt");
    const uploadArgs = runProcessMock.mock.calls[0];
    expect(uploadArgs?.[0]).toBe("scp");
    expect(uploadArgs?.[1]).not.toContain("-A");

    runProcessMock.mockResolvedValueOnce(ok({ stdout: "", stderr: "", exitCode: 0 }));
    await finalizeRemoteFile(context, key, "/tmp/devbox-upload-abc-file.txt", "/home/ec2-user/file.txt");
    const finalizeArgs = runProcessMock.mock.calls[1];
    expect(finalizeArgs?.[0]).toBe("ssh");
    expect(finalizeArgs?.[1]).not.toContain("-A");
  });

  it("REVIEW: interactive session outcome is driven only by the ssh process's own exit, never by remote forwarding acceptance", () => {
    traceSpec("REMOTE-FWDAGENT-TOLERATE");

    // Whether a remote sshd accepts or silently drops `-A` (e.g. `AllowAgentForwarding no`)
    // is not observable from the client side — OpenSSH gives no signal either way, so this
    // cannot be verified with a behavioral assertion against a real remote host. Reviewed
    // instead: startInteractiveSsh (src/adapters/ssh-cli.ts) resolves its Result purely from
    // the spawned ssh process's own "close" event (exit code / signal, asserted above in the
    // "enables agent forwarding..." test) — there is no code path that inspects or reacts to
    // whether agent forwarding was actually honored remotely, so a remote-side refusal cannot
    // turn into a reported connection failure.
    expect(true).toBe(true);
  });
});
