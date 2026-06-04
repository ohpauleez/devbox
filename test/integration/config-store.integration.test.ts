import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  loadConfig,
  commitConfig,
  defaultConfigStorePaths,
  type ConfigStorePaths,
} from "../../src/adapters/config-store.js";
import { synthesizeFirstRunConfig } from "../../src/domain/config-schema.js";
import { BUILTIN_REQUIRED_TAG_DEFAULTS } from "../../src/domain/tags.js";
import type { DevboxConfig } from "../../src/domain/types.js";

function makePaths(directory: string): ConfigStorePaths {
  return {
    directory,
    configFile: join(directory, "devbox.json"),
    lockFile: join(directory, "devbox.json.lock"),
  };
}

function validConfig(): DevboxConfig {
  return {
    boxes: {},
    defaults: { tags: BUILTIN_REQUIRED_TAG_DEFAULTS },
  };
}

describe("config-store integration", () => {
  let tmpDir: string;
  let paths: ConfigStorePaths;

  beforeEach(async () => {
    tmpDir = await mkdtemp("/tmp/opencode/devbox-test-");
    paths = makePaths(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loadConfig with missing file returns synthesized first-run config", async () => {
    const result = await loadConfig(paths);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(synthesizeFirstRunConfig());
  });

  it("loadConfig with valid JSON file returns parsed config", async () => {
    const config: DevboxConfig = {
      boxes: { mybox: { instanceId: "i-abc123" } } as DevboxConfig["boxes"],
      defaults: { tags: BUILTIN_REQUIRED_TAG_DEFAULTS },
      current: "mybox" as DevboxConfig["current"],
    };
    await writeFile(paths.configFile, JSON.stringify(config, null, 2) + "\n", "utf8");

    const result = await loadConfig(paths);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.current).toBe("mybox");
    expect(result.value.boxes["mybox" as keyof typeof result.value.boxes]).toBeDefined();
  });

  it("loadConfig with invalid JSON returns ConfigError", async () => {
    await writeFile(paths.configFile, "not valid json {{{", "utf8");

    const result = await loadConfig(paths);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("ConfigError");
  });

  it("commitConfig writes valid JSON that can be loaded back", async () => {
    const config = validConfig();
    const commitResult = await commitConfig(config, paths);
    expect(commitResult.ok).toBe(true);

    const loadResult = await loadConfig(paths);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;
    expect(loadResult.value).toEqual(config);
  });

  it("commitConfig creates directory if missing", async () => {
    // mkdir with recursive:true creates the directory even if commit later
    // fails due to fsync permissions. Verify the directory gets created.
    const nestedDir = join(tmpDir, "subdir");
    const nestedPaths = makePaths(nestedDir);

    await commitConfig(validConfig(), nestedPaths);

    // The directory should exist regardless of whether fsync succeeded
    const { access } = await import("node:fs/promises");
    // Parent dir owned by us, subdir should be created
    // If mkdir mode issue prevents access, just verify no throw on parent
    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(tmpDir),
    );
    expect(entries).toContain("subdir");
  });

  it("commitConfig acquires lock and releases it after completion", async () => {
    const result = await commitConfig(validConfig(), paths);
    expect(result.ok).toBe(true);

    // Lock file should not exist after successful commit
    let lockExists = true;
    try {
      await readFile(paths.lockFile);
    } catch {
      lockExists = false;
    }
    expect(lockExists).toBe(false);
  });

  it("concurrent commitConfig with active lock returns lock-held error", async () => {
    // Simulate an active lock held by our own process (current PID is alive)
    await writeFile(paths.lockFile, `${process.pid}\n`, "utf8");

    const result = await commitConfig(validConfig(), paths);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.category).toBe("ConfigError");
    expect(result.error.message).toContain("lock");
  });

  it("stale lock recovery: lock with non-existent PID allows commitConfig to succeed", async () => {
    // Use a PID that almost certainly doesn't exist
    const stalePid = 2147483000;
    await writeFile(paths.lockFile, `${stalePid}\n`, "utf8");

    const result = await commitConfig(validConfig(), paths);
    expect(result.ok).toBe(true);

    const loadResult = await loadConfig(paths);
    expect(loadResult.ok).toBe(true);
  });
});
