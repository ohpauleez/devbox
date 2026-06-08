import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/adapters/config-store.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../src/adapters/aws-cli.js", () => ({
  describeInstance: vi.fn(),
  describeSsmPingStatus: vi.fn(),
}));

vi.mock("../../src/adapters/ssh-cli.js", () => ({
  ensureSshKeyMaterial: vi.fn(),
  stageTemporarySshKey: vi.fn(),
}));

vi.mock("../../src/domain/ec2-wait.js", () => ({
  waitForSsmOnline: vi.fn(),
}));

import { loadConfig } from "../../src/adapters/config-store.js";
import { describeInstance, describeSsmPingStatus } from "../../src/adapters/aws-cli.js";
import { ensureSshKeyMaterial, stageTemporarySshKey } from "../../src/adapters/ssh-cli.js";
import { waitForSsmOnline } from "../../src/domain/ec2-wait.js";
import { resolveRemoteAccessPreconditions } from "../../src/cli/remote-access.js";
import { makeTypedError } from "../../src/domain/errors.js";
import { err, ok } from "../../src/domain/result.js";
import { BUILTIN_REQUIRED_TAG_DEFAULTS } from "../../src/domain/tags.js";
import type { BoxAlias, DevboxConfig, InstanceId, SshUser } from "../../src/domain/types.js";
import { traceSpec } from "../support/spec-trace.js";

const loadConfigMock = vi.mocked(loadConfig);
const describeInstanceMock = vi.mocked(describeInstance);
const describeSsmPingStatusMock = vi.mocked(describeSsmPingStatus);
const ensureSshKeyMaterialMock = vi.mocked(ensureSshKeyMaterial);
const stageTemporarySshKeyMock = vi.mocked(stageTemporarySshKey);
const waitForSsmOnlineMock = vi.mocked(waitForSsmOnline);

describe("remote-access preconditions integration", () => {
  const config: DevboxConfig = {
    boxes: {
      alpha: {
        instanceId: "i-alpha123" as InstanceId,
      },
    } as DevboxConfig["boxes"],
    defaults: {
      tags: BUILTIN_REQUIRED_TAG_DEFAULTS,
      sshUser: "ec2-user" as SshUser,
    },
    current: "alpha" as BoxAlias,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    loadConfigMock.mockResolvedValue(ok(config));
    describeInstanceMock.mockResolvedValue(
      ok({
        instanceId: "i-alpha123",
        instanceType: "t3.micro",
        state: "running",
      }),
    );
    describeSsmPingStatusMock.mockResolvedValue(ok("Online"));
    waitForSsmOnlineMock.mockResolvedValue(ok(undefined));
    ensureSshKeyMaterialMock.mockResolvedValue(
      ok({
        privateKeyPath: "/tmp/key",
        publicKeyPath: "/tmp/key.pub",
        fromAgent: false,
      }),
    );
    stageTemporarySshKeyMock.mockResolvedValue(ok(undefined));
  });

  it("continues to staged transport setup when instance is running and SSM-ready", async () => {
    traceSpec("REMOTE-DOMAIN-PRECOND", "REMOTE-PRECOND-READY");

    const result = await resolveRemoteAccessPreconditions();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(waitForSsmOnlineMock).toHaveBeenCalledTimes(1);
    expect(ensureSshKeyMaterialMock).toHaveBeenCalledTimes(1);
    expect(stageTemporarySshKeyMock).toHaveBeenCalledWith(
      {
        instanceId: "i-alpha123",
        sshUser: "ec2-user",
      },
      {
        privateKeyPath: "/tmp/key",
        publicKeyPath: "/tmp/key.pub",
        fromAgent: false,
      },
    );
    expect(result.value.sshContext).toEqual({
      instanceId: "i-alpha123",
      sshUser: "ec2-user",
    });
  });

  it("rejects non-running instances before SSM polling or key staging", async () => {
    traceSpec("REMOTE-DOMAIN-PRECOND", "REMOTE-PRECOND-FAIL");

    describeInstanceMock.mockResolvedValueOnce(
      ok({
        instanceId: "i-alpha123",
        instanceType: "t3.micro",
        state: "stopped",
      }),
    );

    const result = await resolveRemoteAccessPreconditions();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("InstanceStateError");
      expect(result.error.message).toContain("remote access requires running instance");
    }

    expect(waitForSsmOnlineMock).not.toHaveBeenCalled();
    expect(ensureSshKeyMaterialMock).not.toHaveBeenCalled();
    expect(stageTemporarySshKeyMock).not.toHaveBeenCalled();
  });

  it("propagates SSM readiness timeout before key staging", async () => {
    traceSpec("REMOTE-DOMAIN-PRECOND", "REMOTE-PRECOND-FAIL");

    waitForSsmOnlineMock.mockResolvedValueOnce(
      err(makeTypedError("TimeoutError", "instance did not become SSM-ready within 120s")),
    );

    const result = await resolveRemoteAccessPreconditions();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("TimeoutError");
    }

    expect(ensureSshKeyMaterialMock).not.toHaveBeenCalled();
    expect(stageTemporarySshKeyMock).not.toHaveBeenCalled();
  });
});
