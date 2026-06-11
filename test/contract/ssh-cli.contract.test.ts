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

import * as fsPromises from "node:fs/promises";
import * as processAdapter from "../../src/adapters/process.js";
import {
  cleanupLocalTempKeys,
  ensureSshKeyMaterial,
  stageTemporarySshKey,
  validateLocalRegularFile,
} from "../../src/adapters/ssh-cli.js";
import { err, ok } from "../../src/domain/result.js";
import { makeTypedError } from "../../src/domain/errors.js";
import { traceSpec } from "../support/spec-trace.js";

const runProcessMock = vi.mocked(processAdapter.runProcess);
const readFileMock = vi.mocked(fsPromises.readFile);
const statMock = vi.mocked(fsPromises.stat);
const unlinkMock = vi.mocked(fsPromises.unlink);

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
});
