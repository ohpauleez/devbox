import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/adapters/aws-cli.js");
vi.mock("../../src/adapters/ssh-cli.js");

import { loadConfig, commitConfig } from "../../src/adapters/config-store.js";
import { runListCommand } from "../../src/cli/commands/list.js";
import { runSwitchCommand } from "../../src/cli/commands/switch.js";
import { runLocalRemoveCommand } from "../../src/cli/commands/rm.js";
import { ok } from "../../src/domain/result.js";
import { BUILTIN_REQUIRED_TAG_DEFAULTS } from "../../src/domain/tags.js";
import type { DevboxConfig } from "../../src/domain/types.js";

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
  let tmpDir: string;
  const originalEnv = process.env.DEVBOX_CONFIG_DIR;

  beforeEach(async () => {
    tmpDir = await mkdtemp("/tmp/opencode/devbox-test-");
    process.env.DEVBOX_CONFIG_DIR = tmpDir;
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
    await writeConfig(baseConfig());
    const result = await runListCommand();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stdoutLines.join("\n")).toContain("No boxes tracked");
  });

  it("switch command with valid alias updates current in config", async () => {
    await writeConfig(configWithBoxes());
    const result = await runSwitchCommand("beta");
    expect(result.ok).toBe(true);

    const reloaded = await loadConfig();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.current).toBe("beta");
  });

  it("rm local-only removes alias from config", async () => {
    await writeConfig(configWithBoxes());
    const result = await runLocalRemoveCommand("beta");
    expect(result.ok).toBe(true);

    const reloaded = await loadConfig();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect("beta" in reloaded.value.boxes).toBe(false);
    expect("alpha" in reloaded.value.boxes).toBe(true);
  });

  it("rm of current alias clears current", async () => {
    await writeConfig(configWithBoxes());
    const result = await runLocalRemoveCommand("alpha");
    expect(result.ok).toBe(true);

    const reloaded = await loadConfig();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.current).toBeUndefined();
  });
});
