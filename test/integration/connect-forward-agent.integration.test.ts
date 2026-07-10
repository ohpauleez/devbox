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

import { runCli } from "../../src/index.js";
import * as remoteAccess from "../../src/cli/remote-access.js";
import * as sshCli from "../../src/adapters/ssh-cli.js";
import * as configStore from "../../src/adapters/config-store.js";
import { ok } from "../../src/domain/result.js";
import { BUILTIN_REQUIRED_TAG_DEFAULTS } from "../../src/domain/tags.js";
import type { BoxAlias, DevboxConfig, InstanceId, SshUser } from "../../src/domain/types.js";
import { traceSpec } from "../support/spec-trace.js";

const resolveRemoteAccessPreconditionsMock = vi.mocked(remoteAccess.resolveRemoteAccessPreconditions);
const startInteractiveSshMock = vi.mocked(sshCli.startInteractiveSsh);
const cleanupLocalTempKeysMock = vi.mocked(sshCli.cleanupLocalTempKeys);
const commitConfigMock = vi.mocked(configStore.commitConfig);

function stubPreconditionContext() {
  return ok({
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
    sshUser: "bob" as SshUser,
    sshContext: {
      instanceId: "i-alpha123",
      sshUser: "bob",
    },
    key: {
      privateKeyPath: "",
      publicKeyPath: "",
      publicKeyContent: "ssh-rsa AAAAB3...agent== user@host",
      fromAgent: true,
    },
  });
}

describe("connect --forward-agent CLI integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    resolveRemoteAccessPreconditionsMock.mockResolvedValue(stubPreconditionContext());
    startInteractiveSshMock.mockResolvedValue(ok(0));
    cleanupLocalTempKeysMock.mockResolvedValue(undefined);
    commitConfigMock.mockResolvedValue(ok(undefined));
  });

  it("parses --forward-agent and --ssh-user in either order and threads both through", async () => {
    traceSpec("REMOTE-CLI-FORWARDAGENT", "REMOTE-FWDAGENT-PARSE");

    const exitCodeLeading = await runCli(["connect", "--forward-agent", "--ssh-user", "bob"]);
    expect(exitCodeLeading).toBe(0);
    expect(resolveRemoteAccessPreconditionsMock).toHaveBeenCalledWith("bob", true);
    expect(startInteractiveSshMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), true);

    vi.clearAllMocks();
    resolveRemoteAccessPreconditionsMock.mockResolvedValue(stubPreconditionContext());
    startInteractiveSshMock.mockResolvedValue(ok(0));
    cleanupLocalTempKeysMock.mockResolvedValue(undefined);
    commitConfigMock.mockResolvedValue(ok(undefined));

    const exitCodeTrailing = await runCli(["connect", "--ssh-user", "bob", "--forward-agent"]);
    expect(exitCodeTrailing).toBe(0);
    expect(resolveRemoteAccessPreconditionsMock).toHaveBeenCalledWith("bob", true);
    expect(startInteractiveSshMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), true);
  });

  it("omitting --forward-agent preserves prior behavior", async () => {
    const exitCode = await runCli(["connect"]);
    expect(exitCode).toBe(0);
    expect(resolveRemoteAccessPreconditionsMock).toHaveBeenCalledWith(undefined, false);
    expect(startInteractiveSshMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), false);
  });

  it("rejects --forward-agent on cp before any remote-access setup begins", async () => {
    traceSpec("REMOTE-FWDAGENT-CPREJECT");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitCode = await runCli(["cp", "--forward-agent", "local.txt", "/remote/path.txt"]);

    expect(exitCode).toBe(2);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("usage: devbox cp <local> <remote>"));
    stderrSpy.mockRestore();

    // Parsing failed before dispatch ever ran, so no remote-access setup, transport,
    // or config update occurred.
    expect(resolveRemoteAccessPreconditionsMock).not.toHaveBeenCalled();
    expect(startInteractiveSshMock).not.toHaveBeenCalled();
    expect(commitConfigMock).not.toHaveBeenCalled();
  });
});
