import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mutateConfig, readConfigForList } from "../src/adapters/config-store.js";

describe.sequential("config-store lock recovery", () => {
  let tempDir = "";
  const originalConfigDir = process.env.DEVBOX_CONFIG_DIR;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "devbox-lock-test-"));
    process.env.DEVBOX_CONFIG_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.DEVBOX_CONFIG_DIR;
    } else {
      process.env.DEVBOX_CONFIG_DIR = originalConfigDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects lock held by live recent process", async () => {
    const lockPath = path.join(tempDir, "devbox.json.lock");
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(lockPath, String(process.pid), "utf8");

    await expect(
      mutateConfig((cfg) => ({
        ...cfg,
        boxes: { ...cfg.boxes, a: { instanceId: "i-1" } },
      })),
    ).rejects.toMatchObject({ code: "ConfigError" });
  });

  it("recovers stale lock with invalid PID", async () => {
    const lockPath = path.join(tempDir, "devbox.json.lock");
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(lockPath, "invalid-pid", "utf8");

    await mutateConfig((cfg) => ({
      ...cfg,
      boxes: { ...cfg.boxes, a: { instanceId: "i-1" } },
      current: "a",
    }));

    const cfg = await readConfigForList();
    expect(cfg.boxes.a?.instanceId).toBe("i-1");
  });

  it("recovers stale lock by age even when PID is live", async () => {
    const lockPath = path.join(tempDir, "devbox.json.lock");
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(lockPath, String(process.pid), "utf8");
    const old = new Date(Date.now() - 6 * 60_000);
    await fs.utimes(lockPath, old, old);

    await mutateConfig((cfg) => ({
      ...cfg,
      boxes: { ...cfg.boxes, a: { instanceId: "i-1" } },
      current: "a",
    }));

    const cfg = await readConfigForList();
    expect(cfg.boxes.a?.instanceId).toBe("i-1");
  });
});
