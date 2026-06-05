import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../../src/adapters/process.js", () => ({
  runProcess: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
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

  it("prefers ssh-agent key material when available", async () => {
    traceSpec("REMOTE-ADAPTER-KEYSTORE", "REMOTE-KEY-AGENT");

    runProcessMock.mockResolvedValueOnce(ok({ stdout: "key", stderr: "", exitCode: 0 }));

    const result = await ensureSshKeyMaterial();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.fromAgent).toBe(true);
    expect(result.value.privateKeyPath).toBe("");
    expect(result.value.publicKeyPath).toBe("");
  });

  it("falls back to generated temporary key material when ssh-agent is unavailable", async () => {
    traceSpec("REMOTE-ADAPTER-KEYSTORE", "REMOTE-KEY-TEMP");

    runProcessMock
      .mockResolvedValueOnce(err(makeTypedError("TransportError", "ssh-add failed")))
      .mockResolvedValueOnce(ok({ stdout: "", stderr: "", exitCode: 0 }));

    const result = await ensureSshKeyMaterial();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.fromAgent).toBe(false);
    expect(result.value.privateKeyPath).toContain("ssm-ssh-tmp-");
    expect(result.value.publicKeyPath).toContain(".pub");
  });

  it("stages temporary key via SSM with bounded remote cleanup command", async () => {
    traceSpec("REMOTE-ADAPTER-STAGE", "REMOTE-STAGE-SUCCESS", "REMOTE-KEY-REMOTE-CLEANUP");

    runProcessMock.mockResolvedValueOnce(ok({ stdout: "{}", stderr: "", exitCode: 0 }));

    const stageResult = await stageTemporarySshKey(
      { instanceId: "i-alpha123", sshUser: "ec2-user" },
      { privateKeyPath: "/tmp/key", publicKeyPath: "/tmp/key.pub", fromAgent: false },
    );
    expect(stageResult.ok).toBe(true);

    const commandInvocation = runProcessMock.mock.calls[0];
    expect(commandInvocation?.[0]).toBe("aws");
    expect(commandInvocation?.[1].join(" ")).toContain("send-command");
    expect(commandInvocation?.[1].join(" ")).toContain("authorized_keys");
    expect(commandInvocation?.[1].join(" ")).toContain("sleep 15");
  });

  it("reports transport error when key staging command fails", async () => {
    traceSpec("REMOTE-STAGE-FAIL");

    runProcessMock.mockResolvedValueOnce(
      err(makeTypedError("TransportError", "ssm send-command failed", ["boom"])),
    );

    const stageResult = await stageTemporarySshKey(
      { instanceId: "i-alpha123", sshUser: "ec2-user" },
      { privateKeyPath: "/tmp/key", publicKeyPath: "/tmp/key.pub", fromAgent: false },
    );
    expect(stageResult.ok).toBe(false);
    if (!stageResult.ok) {
      expect(stageResult.error.category).toBe("TransportError");
    }
  });

  it("cleans up generated local temp keys", async () => {
    traceSpec("REMOTE-KEY-TEMP");

    unlinkMock.mockResolvedValue(undefined);

    await cleanupLocalTempKeys({
      fromAgent: false,
      privateKeyPath: "/tmp/key",
      publicKeyPath: "/tmp/key.pub",
    });

    expect(unlinkMock).toHaveBeenCalledTimes(2);
  });
});
