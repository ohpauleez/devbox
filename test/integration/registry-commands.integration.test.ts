import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";

import type { DevboxConfig } from "../../src/domain/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(),
  };
});

vi.mock("../../src/adapters/aws-cli.js", () => ({
  describeInstance: vi.fn(),
  runInstances: vi.fn(),
  terminateInstance: vi.fn(),
}));

vi.mock("../../src/adapters/config-store.js", () => ({
  loadConfig: vi.fn(),
  commitConfig: vi.fn(),
}));

import { runAddCommand } from "../../src/cli/commands/add.js";
import { runInitCommand } from "../../src/cli/commands/init.js";
import { runSwitchCommand } from "../../src/cli/commands/switch.js";
import { runTerminateRemoveCommand } from "../../src/cli/commands/rm.js";
import * as awsCli from "../../src/adapters/aws-cli.js";
import * as configStore from "../../src/adapters/config-store.js";
import * as fsPromises from "node:fs/promises";
import { ok, err } from "../../src/domain/result.js";
import { makeTypedError } from "../../src/domain/errors.js";
import { BUILTIN_REQUIRED_TAG_DEFAULTS } from "../../src/domain/tags.js";

const describeInstanceMock = vi.mocked(awsCli.describeInstance);
const runInstancesMock = vi.mocked(awsCli.runInstances);
const terminateInstanceMock = vi.mocked(awsCli.terminateInstance);
const loadConfigMock = vi.mocked(configStore.loadConfig);
const commitConfigMock = vi.mocked(configStore.commitConfig);
const readFileMock = vi.mocked(fsPromises.readFile);

function baseConfig(): DevboxConfig {
  return {
    boxes: {
      alpha: { instanceId: "i-alpha111" },
    } as DevboxConfig["boxes"],
    defaults: {
      tags: BUILTIN_REQUIRED_TAG_DEFAULTS,
      ImageId: "ami-default",
      IamInstanceProfile: { Arn: "arn:aws:iam::123:instance-profile/devbox" },
    },
    current: "alpha" as DevboxConfig["current"],
  };
}

describe("registry command integration", () => {
  let config: DevboxConfig;

  beforeEach(() => {
    config = baseConfig();

    loadConfigMock.mockImplementation(async () => ok(config));
    commitConfigMock.mockImplementation(async (nextConfig: DevboxConfig) => {
      config = nextConfig;
      return ok(undefined);
    });

    describeInstanceMock.mockResolvedValue(
      ok({ instanceId: "i-alpha111", state: "running", instanceType: "t3.micro" }),
    );
    runInstancesMock.mockResolvedValue(ok({ instanceId: "i-new999" }));
    terminateInstanceMock.mockResolvedValue(ok("terminated"));
    readFileMock.mockReset();
  });

  it("add succeeds and sets alias as current", async () => {
    traceSpec("BOX-CLI-REGISTRY", "BOX-DOMAIN-ADD", "BOX-ADD-SUCCESS");

    describeInstanceMock.mockResolvedValue(
      ok({ instanceId: "i-new123", state: "running", instanceType: "t3.micro" }),
    );

    const result = await runAddCommand("i-new123", "beta");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.stdoutLines).toEqual(["i-new123"]);
    expect(config.current).toBe("beta");
    expect(config.boxes["beta" as keyof typeof config.boxes]?.instanceId).toBe("i-new123");
  });

  it("add warns for malformed-looking but describable instance ids", async () => {
    traceSpec("BOX-DOMAIN-INSTANCEID", "BOX-INSTANCEID-WARN");

    describeInstanceMock.mockResolvedValue(
      ok({ instanceId: "custom-instance-id", state: "running", instanceType: "t3.micro" }),
    );

    const result = await runAddCommand("custom-instance-id", "beta");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.stderrLines.join("\n")).toContain("does not match advisory EC2 pattern");
  });

  it("add fails when instance is not describable", async () => {
    traceSpec("BOX-DOMAIN-INSTANCEID", "BOX-DOMAIN-ADD", "BOX-INSTANCEID-FAIL", "BOX-ADD-FAIL");

    describeInstanceMock.mockResolvedValue(
      err(makeTypedError("NotFoundError", "instance not found")),
    );

    const result = await runAddCommand("i-missing123", "beta");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("NotFoundError");
    }
  });

  it("switch fails for missing alias without mutating current", async () => {
    traceSpec("BOX-CLI-REGISTRY", "BOX-DOMAIN-SWITCH", "BOX-REGISTRY-CLI-FAIL", "BOX-SWITCH-FAIL");

    const previousCurrent = config.current;
    const result = await runSwitchCommand("ghost");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("ValidationError");
    }
    expect(config.current).toBe(previousCurrent);
  });

  it("init success commits launched instance and sets current", async () => {
    traceSpec("BOX-CLI-REGISTRY", "BOX-DOMAIN-INIT", "BOX-INIT-SUCCESS");

    const templateJson = {
      ImageId: "ami-template",
      IamInstanceProfile: { Arn: "arn:aws:iam::123:instance-profile/template" },
    };

    readFileMock.mockResolvedValueOnce(JSON.stringify(templateJson));

    const result = await runInitCommand("beta", "/fake/template.json");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.stdoutLines).toEqual(["i-new999"]);
    expect(config.current).toBe("beta");
    expect(config.boxes["beta" as keyof typeof config.boxes]?.instanceId).toBe("i-new999");

  });

  it("init reports consistency error when launch succeeds but commit fails", async () => {
    traceSpec("BOX-DOMAIN-INIT", "BOX-INIT-CONSISTENCY");

    const templateJson = {
      ImageId: "ami-template",
      IamInstanceProfile: { Arn: "arn:aws:iam::123:instance-profile/template" },
    };

    readFileMock.mockResolvedValueOnce(JSON.stringify(templateJson));

    commitConfigMock.mockResolvedValueOnce(
      err(makeTypedError("ConfigError", "disk full")),
    );

    const result = await runInitCommand("beta", "/fake/template.json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("ConsistencyError");
      expect(result.error.message).toContain("instance launched");
    }

  });

  it("terminate remove reports consistency error when AWS accepts termination but commit fails", async () => {
    traceSpec("BOX-DOMAIN-RM", "BOX-RM-CONSISTENCY");

    commitConfigMock.mockResolvedValueOnce(
      err(makeTypedError("ConfigError", "cannot write config")),
    );

    const result = await runTerminateRemoveCommand("alpha");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("ConsistencyError");
      expect(result.error.message).toContain("AWS termination accepted");
    }
  });
});
