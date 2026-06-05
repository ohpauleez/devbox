import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/adapters/aws-cli.js");
vi.mock("../../src/adapters/ssh-cli.js");

import { loadConfig, commitConfig } from "../../src/adapters/config-store.js";
import * as awsCli from "../../src/adapters/aws-cli.js";
import { runListCommand } from "../../src/cli/commands/list.js";
import { runSwitchCommand } from "../../src/cli/commands/switch.js";
import { runLocalRemoveCommand } from "../../src/cli/commands/rm.js";
import { err, ok } from "../../src/domain/result.js";
import { makeTypedError } from "../../src/domain/errors.js";
import { BUILTIN_REQUIRED_TAG_DEFAULTS } from "../../src/domain/tags.js";
import type { DevboxConfig } from "../../src/domain/types.js";
import { traceSpec } from "../support/spec-trace.js";

function baseConfig(): DevboxConfig {
  return {
    boxes: {},
    defaults: { tags: BUILTIN_REQUIRED_TAG_DEFAULTS },
  };
}

function configWithBoxes(): DevboxConfig {
  return {
    boxes: {
      alpha: { instanceId: "i-aaa111" },
      beta: { instanceId: "i-bbb222" },
    } as DevboxConfig["boxes"],
    defaults: { tags: BUILTIN_REQUIRED_TAG_DEFAULTS },
    current: "alpha" as DevboxConfig["current"],
  };
}

describe("command-flows integration", () => {
  const describeInstancesMock = vi.mocked(awsCli.describeInstances);
  let tmpDir: string;
  const originalEnv = process.env.DEVBOX_CONFIG_DIR;

  beforeEach(async () => {
    tmpDir = await mkdtemp("/tmp/opencode/devbox-test-");
    process.env.DEVBOX_CONFIG_DIR = tmpDir;
    describeInstancesMock.mockResolvedValue(ok(new Map()));
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.DEVBOX_CONFIG_DIR;
    } else {
      process.env.DEVBOX_CONFIG_DIR = originalEnv;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeConfig(config: DevboxConfig): Promise<void> {
    await writeFile(
      join(tmpDir, "devbox.json"),
      JSON.stringify(config, null, 2) + "\n",
      "utf8",
    );
  }

  it("list command with empty config returns no boxes tracked", async () => {
    traceSpec("BOX-CLI-REGISTRY");

    await writeConfig(baseConfig());
    const result = await runListCommand();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stdoutLines.join("\n")).toContain("No boxes tracked");
  });

  it("list without config file succeeds and does not create config", async () => {
    traceSpec("BOX-LIST-NOCONFIG");

    const configPath = join(tmpDir, "devbox.json");
    const result = await runListCommand();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.stdoutLines).toEqual(["No boxes tracked"]);

    await expect(access(configPath)).rejects.toBeDefined();
  });

  it("list enriches all tracked boxes with one batch describe call", async () => {
    traceSpec("BOX-CLI-LIST-FORMAT", "BOX-DOMAIN-LIST-BATCH", "BOX-LIST-BATCH-SINGLE");

    await writeConfig(configWithBoxes());
    describeInstancesMock.mockResolvedValueOnce(
      ok(
        new Map([
          ["i-aaa111", { instanceId: "i-aaa111", state: "running", instanceType: "t3.micro" }],
          ["i-bbb222", { instanceId: "i-bbb222", state: "stopped", instanceType: "t3.small" }],
        ]),
      ),
    );

    const result = await runListCommand();
    expect(result.ok).toBe(true);
    expect(describeInstancesMock).toHaveBeenCalledTimes(1);
    expect(describeInstancesMock).toHaveBeenCalledWith(["i-aaa111", "i-bbb222"]);
  });

  it("list degrades gracefully to unknown state when AWS enrichment fails", async () => {
    traceSpec("BOX-CLI-LIST-FORMAT", "BOX-DOMAIN-LIST-BATCH", "BOX-LIST-BATCH-UNAVAIL");

    await writeConfig(configWithBoxes());
    describeInstancesMock.mockResolvedValueOnce(
      err(makeTypedError("AwsCliError", "aws unavailable")),
    );

    const result = await runListCommand();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.stdoutLines.join("\n")).toContain("unknown");
  });

  it("switch command with valid alias updates current in config", async () => {
    traceSpec("BOX-DOMAIN-SWITCH", "BOX-SWITCH-SUCCESS");

    await writeConfig(configWithBoxes());
    const result = await runSwitchCommand("beta");
    expect(result.ok).toBe(true);

    const reloaded = await loadConfig();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.current).toBe("beta");
  });

  it("rm local-only removes alias from config", async () => {
    traceSpec("BOX-DOMAIN-RM", "BOX-RM-LOCAL", "BOX-DOMAIN-RM-WARN", "BOX-RM-WARN-MSG");

    await writeConfig(configWithBoxes());
    const result = await runLocalRemoveCommand("beta");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const reloaded = await loadConfig();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect("beta" in reloaded.value.boxes).toBe(false);
    expect("alpha" in reloaded.value.boxes).toBe(true);
    expect(result.value.stderrLines.join("\n")).toContain("associated AWS resources may still exist");
  });

  it("rm of current alias clears current", async () => {
    traceSpec("BOX-DOMAIN-RM", "BOX-DOMAIN-RM-CURRENT", "BOX-RM-CURRENT-CLEAR");

    await writeConfig(configWithBoxes());
    const result = await runLocalRemoveCommand("alpha");
    expect(result.ok).toBe(true);

    const reloaded = await loadConfig();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.current).toBeUndefined();
  });
});
