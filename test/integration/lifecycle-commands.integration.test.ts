import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/adapters/aws-cli.js");

import * as awsCli from "../../src/adapters/aws-cli.js";
import { runDownCommand } from "../../src/cli/commands/down.js";
import { runUpCommand } from "../../src/cli/commands/up.js";
import { ok, err } from "../../src/domain/result.js";
import { makeTypedError } from "../../src/domain/errors.js";
import { BUILTIN_REQUIRED_TAG_DEFAULTS } from "../../src/domain/tags.js";
import type { DevboxConfig } from "../../src/domain/types.js";
import { traceSpec } from "../support/spec-trace.js";

const describeInstanceMock = vi.mocked(awsCli.describeInstance);
const startInstanceMock = vi.mocked(awsCli.startInstance);
const stopInstanceMock = vi.mocked(awsCli.stopInstance);

function configWithCurrent(alias: string, instanceId: string): DevboxConfig {
  return {
    boxes: {
      [alias]: { instanceId },
    } as DevboxConfig["boxes"],
    defaults: { tags: BUILTIN_REQUIRED_TAG_DEFAULTS },
    current: alias as DevboxConfig["current"],
  };
}

describe("lifecycle command integration", () => {
  let tmpDir: string;
  const originalConfigDir = process.env.DEVBOX_CONFIG_DIR;

  beforeEach(async () => {
    tmpDir = await mkdtemp("/tmp/opencode/devbox-lifecycle-");
    process.env.DEVBOX_CONFIG_DIR = tmpDir;
    vi.clearAllMocks();

    startInstanceMock.mockResolvedValue(ok(undefined));
    stopInstanceMock.mockResolvedValue(ok(undefined));
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.DEVBOX_CONFIG_DIR;
    } else {
      process.env.DEVBOX_CONFIG_DIR = originalConfigDir;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("up requires current selection", async () => {
    traceSpec("LIFE-CLI-CMDS", "LIFE-CURRENT-REQ");

    const config: DevboxConfig = {
      boxes: {},
      defaults: { tags: BUILTIN_REQUIRED_TAG_DEFAULTS },
    };
    await writeFile(join(tmpDir, "devbox.json"), JSON.stringify(config, null, 2) + "\n", "utf8");

    const result = await runUpCommand();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("ValidationError");
    }
  });

  it("down requires current selection", async () => {
    traceSpec("LIFE-CLI-CMDS", "LIFE-CURRENT-REQ");

    const config: DevboxConfig = {
      boxes: {},
      defaults: { tags: BUILTIN_REQUIRED_TAG_DEFAULTS },
    };
    await writeFile(join(tmpDir, "devbox.json"), JSON.stringify(config, null, 2) + "\n", "utf8");

    const result = await runDownCommand();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("ValidationError");
    }
  });

  it("up from stopped sends start request and prints instance id", async () => {
    traceSpec("LIFE-CLI-CMDS", "LIFE-CLI-SUCCESS", "LIFE-UP-START");

    const config = configWithCurrent("alpha", "i-alpha123");
    await writeFile(join(tmpDir, "devbox.json"), JSON.stringify(config, null, 2) + "\n", "utf8");

    describeInstanceMock
      .mockResolvedValueOnce(ok({ instanceId: "i-alpha123", state: "stopped", instanceType: "t3.micro" }))
      .mockResolvedValue(ok({ instanceId: "i-alpha123", state: "running", instanceType: "t3.micro" }));

    const result = await runUpCommand();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(startInstanceMock).toHaveBeenCalledWith("i-alpha123");
    expect(result.value.stdoutLines).toEqual(["i-alpha123"]);
  });

  it("down from running sends stop request and prints instance id", async () => {
    traceSpec("LIFE-CLI-CMDS", "LIFE-CLI-SUCCESS", "LIFE-DOWN-STOP");

    const config = configWithCurrent("alpha", "i-alpha123");
    await writeFile(join(tmpDir, "devbox.json"), JSON.stringify(config, null, 2) + "\n", "utf8");

    describeInstanceMock
      .mockResolvedValueOnce(ok({ instanceId: "i-alpha123", state: "running", instanceType: "t3.micro" }))
      .mockResolvedValue(ok({ instanceId: "i-alpha123", state: "stopped", instanceType: "t3.micro" }));

    const result = await runDownCommand();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(stopInstanceMock).toHaveBeenCalledWith("i-alpha123");
    expect(result.value.stdoutLines).toEqual(["i-alpha123"]);
  });

  it("up returns not-found for stale current instance", async () => {
    traceSpec("LIFE-DOMAIN-SCOPE", "LIFE-SCOPE-FAIL", "LIFE-DOMAIN-STALE", "LIFE-STALE-FAIL");

    const config = configWithCurrent("alpha", "i-stale123");
    await writeFile(join(tmpDir, "devbox.json"), JSON.stringify(config, null, 2) + "\n", "utf8");

    describeInstanceMock.mockResolvedValue(err(makeTypedError("NotFoundError", "instance not found")));

    const result = await runUpCommand();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("NotFoundError");
    }
  });

  it("down returns not-found for stale current instance", async () => {
    traceSpec("LIFE-DOMAIN-SCOPE", "LIFE-SCOPE-FAIL", "LIFE-DOMAIN-STALE", "LIFE-STALE-FAIL");

    const config = configWithCurrent("alpha", "i-stale123");
    await writeFile(join(tmpDir, "devbox.json"), JSON.stringify(config, null, 2) + "\n", "utf8");

    describeInstanceMock.mockResolvedValue(err(makeTypedError("NotFoundError", "instance not found")));

    const result = await runDownCommand();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("NotFoundError");
    }
  });

  it("up continues when current instance is describable in active context", async () => {
    traceSpec("LIFE-DOMAIN-SCOPE", "LIFE-SCOPE-ACTIVE", "LIFE-DOMAIN-STALE", "LIFE-STALE-PASS");

    const config = configWithCurrent("alpha", "i-live123");
    await writeFile(join(tmpDir, "devbox.json"), JSON.stringify(config, null, 2) + "\n", "utf8");

    describeInstanceMock.mockResolvedValue(
      ok({ instanceId: "i-live123", state: "running", instanceType: "t3.micro" }),
    );

    const result = await runUpCommand();
    expect(result.ok).toBe(true);
  });
});
