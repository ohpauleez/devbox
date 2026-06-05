import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/cli/remote-access.js", () => ({
  resolveRemoteAccessPreconditions: vi.fn(),
}));

vi.mock("../../src/adapters/ssh-cli.js", () => ({
  startInteractiveSsh: vi.fn(),
  cleanupLocalTempKeys: vi.fn(),
  validateLocalRegularFile: vi.fn(),
  uploadFileOverScp: vi.fn(),
  finalizeRemoteFile: vi.fn(),
}));

vi.mock("../../src/adapters/config-store.js", () => ({
  commitConfig: vi.fn(),
}));

import { runConnectCommand } from "../../src/cli/commands/connect.js";
import { runCpCommand } from "../../src/cli/commands/cp.js";
import * as remoteAccess from "../../src/cli/remote-access.js";
import * as sshCli from "../../src/adapters/ssh-cli.js";
import * as configStore from "../../src/adapters/config-store.js";
import { err, ok } from "../../src/domain/result.js";
import { makeTypedError } from "../../src/domain/errors.js";
import { BUILTIN_REQUIRED_TAG_DEFAULTS } from "../../src/domain/tags.js";
import type { BoxAlias, DevboxConfig, InstanceId, SshUser } from "../../src/domain/types.js";
import { traceSpec } from "../support/spec-trace.js";

const resolveRemoteAccessPreconditionsMock = vi.mocked(remoteAccess.resolveRemoteAccessPreconditions);
const startInteractiveSshMock = vi.mocked(sshCli.startInteractiveSsh);
const cleanupLocalTempKeysMock = vi.mocked(sshCli.cleanupLocalTempKeys);
const validateLocalRegularFileMock = vi.mocked(sshCli.validateLocalRegularFile);
const uploadFileOverScpMock = vi.mocked(sshCli.uploadFileOverScp);
const finalizeRemoteFileMock = vi.mocked(sshCli.finalizeRemoteFile);
const commitConfigMock = vi.mocked(configStore.commitConfig);

describe("remote command integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    resolveRemoteAccessPreconditionsMock.mockResolvedValue(
      ok({
        config: {
          boxes: {
            alpha: { instanceId: "i-alpha123" as InstanceId },
          } as DevboxConfig["boxes"],
          defaults: { tags: BUILTIN_REQUIRED_TAG_DEFAULTS },
          current: "alpha" as BoxAlias,
        },
        current: {
          alias: "alpha" as BoxAlias,
          box: { instanceId: "i-alpha123" as InstanceId },
        },
        sshUser: "ec2-user" as SshUser,
        sshContext: {
          instanceId: "i-alpha123",
          sshUser: "ec2-user",
        },
        key: {
          privateKeyPath: "/tmp/key",
          publicKeyPath: "/tmp/key.pub",
          fromAgent: false,
        },
      }),
    );

    startInteractiveSshMock.mockResolvedValue(ok(0));
    cleanupLocalTempKeysMock.mockResolvedValue(undefined);
    validateLocalRegularFileMock.mockResolvedValue(ok(undefined));
    uploadFileOverScpMock.mockResolvedValue(ok("/tmp/devbox-upload-123-file.txt"));
    finalizeRemoteFileMock.mockResolvedValue(ok(undefined));
    commitConfigMock.mockResolvedValue(ok(undefined));
  });

  it("connect updates lastConnectAt after a successful session", async () => {
    traceSpec(
      "REMOTE-CLI-CMDS",
      "REMOTE-DOMAIN-CONNECT",
      "REMOTE-CONNECT-SUCCESS",
      "REMOTE-ADAPTER-CLEANUP",
      "REMOTE-CLEANUP-SUCCESS",
    );

    const result = await runConnectCommand();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.stdoutLines).toEqual([]);
    expect(result.value.stderrLines).toEqual([]);
    expect(result.value.exitCode).toBeUndefined();
    expect(commitConfigMock).toHaveBeenCalledTimes(1);
    expect(cleanupLocalTempKeysMock).toHaveBeenCalledTimes(1);
  });

  it("connect propagates ssh child exit code", async () => {
    traceSpec("REMOTE-DOMAIN-SESSION", "REMOTE-SESSION-EXIT");

    startInteractiveSshMock.mockResolvedValueOnce(ok(23));

    const result = await runConnectCommand();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.exitCode).toBe(23);
  });

  it("connect reports consistency error when commit fails after session success", async () => {
    traceSpec("REMOTE-CONNECT-CONSISTENCY");

    commitConfigMock.mockResolvedValueOnce(err(makeTypedError("ConfigError", "failed write")));

    const result = await runConnectCommand();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("ConsistencyError");
      expect(result.error.message).toContain("lastConnectAt update failed");
    }
    expect(cleanupLocalTempKeysMock).toHaveBeenCalledTimes(1);
  });

  it("connect returns transport error details on local session failure and still cleans up", async () => {
    traceSpec("REMOTE-ADAPTER-CLEANUP", "REMOTE-CLEANUP-SUCCESS");

    startInteractiveSshMock.mockResolvedValueOnce(
      err(makeTypedError("TransportError", "failed to start ssh session", ["ssh exited 255"])),
    );

    const result = await runConnectCommand();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("TransportError");
      expect(result.error.message).toContain("failed to start ssh session");
      expect(result.error.details).toContain("ssh exited 255");
    }

    expect(cleanupLocalTempKeysMock).toHaveBeenCalledTimes(1);
  });

  it("connect preserves transport error when cleanup also fails", async () => {
    traceSpec("REMOTE-ADAPTER-CLEANUP", "REMOTE-CLEANUP-FAIL");

    startInteractiveSshMock.mockResolvedValueOnce(
      err(makeTypedError("TransportError", "failed to start ssh session", ["ssh exited 255"])),
    );
    cleanupLocalTempKeysMock.mockRejectedValueOnce(new Error("unlink permission denied"));

    const result = await runConnectCommand();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("TransportError");
      expect(result.error.message).toContain("failed to start ssh session");
    }
  });

  it("cp uploads to temp, finalizes, and updates lastConnectAt", async () => {
    traceSpec(
      "REMOTE-CLI-CMDS",
      "REMOTE-DOMAIN-CP",
      "REMOTE-CP-SUCCESS",
      "REMOTE-ADAPTER-CLEANUP",
      "REMOTE-CLEANUP-SUCCESS",
    );

    const result = await runCpCommand("/tmp/local.txt", "/home/ec2-user/remote.txt");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(uploadFileOverScpMock).toHaveBeenCalledTimes(1);
    expect(finalizeRemoteFileMock).toHaveBeenCalledTimes(1);
    expect(result.value.stdoutLines).toEqual(["/home/ec2-user/remote.txt"]);
    expect(cleanupLocalTempKeysMock).toHaveBeenCalledTimes(1);
  });

  it("cp reports consistency error when commit fails after remote success", async () => {
    traceSpec("REMOTE-CP-CONSISTENCY");

    commitConfigMock.mockResolvedValueOnce(err(makeTypedError("ConfigError", "failed write")));

    const result = await runCpCommand("/tmp/local.txt", "/home/ec2-user/remote.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("ConsistencyError");
      expect(result.error.message).toContain("copy succeeded remotely");
    }
  });
});
