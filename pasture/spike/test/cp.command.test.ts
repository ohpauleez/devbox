import { describe, expect, it, vi } from "vitest";
import { createCpCommand } from "../src/cli/commands/cp.js";
import { synthesizeFirstRunConfig } from "../src/domain/config-schema.js";
import { createDeterministicRuntime } from "./helpers/runtime.js";

function cfgWithCurrent() {
  const cfg = synthesizeFirstRunConfig();
  cfg.current = "work";
  cfg.boxes.work = { instanceId: "i-1" };
  return cfg;
}

describe("cp command contracts", () => {
  it("uploads via temp path then finalizes and updates lastConnectAt", async () => {
    const uploads: Array<{ instanceId: string; local: string; remote: string }> = [];
    const finalizes: Array<{ instanceId: string; from: string; to: string }> = [];
    const prints: string[] = [];
    let cfg = cfgWithCurrent();

    const cmd = createCpCommand({
      stat: vi.fn(async () => ({ isFile: () => true, size: 12 })) as never,
      readConfig: vi.fn(async () => cfg),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "running", instanceType: "t3" })),
      waitForSsm: vi.fn(async () => {}),
      scpUpload: vi.fn(async (instanceId: string, local: string, remote: string) => {
        uploads.push({ instanceId, local, remote });
      }) as never,
      finalizeMove: vi.fn(async (instanceId: string, from: string, to: string) => {
        finalizes.push({ instanceId, from, to });
      }) as never,
      mutateConfig: vi.fn(async (mutator) => {
        cfg = mutator(cfg);
        return cfg;
      }) as never,
      print: (s) => prints.push(s),
      runtime: createDeterministicRuntime({
        nextId: ["uuid-1"],
        nowIso: ["2026-06-01T09:10:00.000Z"],
      }),
    });

    await cmd("./local.txt", "/tmp/remote.txt");

    expect(uploads[0]?.remote).toBe("/tmp/.remote.txt.devbox-tmp-uuid-1");
    expect(finalizes[0]).toEqual({
      instanceId: "i-1",
      from: "/tmp/.remote.txt.devbox-tmp-uuid-1",
      to: "/tmp/remote.txt",
    });
    expect(cfg.boxes.work?.lastConnectAt).toBe("2026-06-01T09:10:00.000Z");
    expect(prints).toEqual(["work /tmp/remote.txt"]);
  });

  it("rejects non-regular file and does not call transport", async () => {
    const scp = vi.fn();
    const cmd = createCpCommand({
      stat: vi.fn(async () => ({ isFile: () => false, size: 10 })) as never,
      readConfig: vi.fn() as never,
      describe: vi.fn() as never,
      waitForSsm: vi.fn() as never,
      scpUpload: scp as never,
      finalizeMove: vi.fn() as never,
      mutateConfig: vi.fn() as never,
      print: vi.fn(),
      runtime: createDeterministicRuntime(),
    });

    await expect(cmd("./x", "/tmp/y")).rejects.toMatchObject({ code: "ValidationError" });
    expect(scp).not.toHaveBeenCalled();
  });

  it("rejects missing local source before AWS calls", async () => {
    const readConfig = vi.fn();
    const cmd = createCpCommand({
      stat: vi.fn(async () => {
        throw new Error("ENOENT");
      }) as never,
      readConfig: readConfig as never,
      describe: vi.fn() as never,
      waitForSsm: vi.fn() as never,
      scpUpload: vi.fn() as never,
      finalizeMove: vi.fn() as never,
      mutateConfig: vi.fn() as never,
      print: vi.fn(),
      runtime: createDeterministicRuntime(),
    });

    await expect(cmd("./missing", "/tmp/remote")).rejects.toMatchObject({ code: "ValidationError" });
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("rejects oversized source file", async () => {
    const cmd = createCpCommand({
      stat: vi.fn(async () => ({ isFile: () => true, size: 1024 * 1024 * 1024 + 1 })) as never,
      readConfig: vi.fn() as never,
      describe: vi.fn() as never,
      waitForSsm: vi.fn() as never,
      scpUpload: vi.fn() as never,
      finalizeMove: vi.fn() as never,
      mutateConfig: vi.fn() as never,
      print: vi.fn(),
      runtime: createDeterministicRuntime(),
    });

    await expect(cmd("./local", "/tmp/remote")).rejects.toMatchObject({ code: "ValidationError" });
  });

  it("does not mutate config if finalize fails", async () => {
    const mutate = vi.fn();
    const cmd = createCpCommand({
      stat: vi.fn(async () => ({ isFile: () => true, size: 12 })) as never,
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "running", instanceType: "t3" })),
      waitForSsm: vi.fn(async () => {}),
      scpUpload: vi.fn(async () => {}),
      finalizeMove: vi.fn(async () => {
        throw new Error("finalize failed");
      }),
      mutateConfig: mutate as never,
      print: vi.fn(),
      runtime: createDeterministicRuntime({ nextId: ["uuid-1"] }),
    });

    await expect(cmd("./local", "/tmp/remote")).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("does not finalize or mutate when upload fails", async () => {
    const finalizeMove = vi.fn();
    const mutate = vi.fn();
    const cmd = createCpCommand({
      stat: vi.fn(async () => ({ isFile: () => true, size: 12 })) as never,
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "running", instanceType: "t3" })),
      waitForSsm: vi.fn(async () => {}),
      scpUpload: vi.fn(async () => {
        throw new Error("upload failed");
      }),
      finalizeMove: finalizeMove as never,
      mutateConfig: mutate as never,
      print: vi.fn(),
      runtime: createDeterministicRuntime({ nextId: ["uuid-1"] }),
    });

    await expect(cmd("./local", "/tmp/remote")).rejects.toThrow();
    expect(finalizeMove).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("does not mutate when SSM readiness fails", async () => {
    const mutate = vi.fn();
    const cmd = createCpCommand({
      stat: vi.fn(async () => ({ isFile: () => true, size: 12 })) as never,
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "running", instanceType: "t3" })),
      waitForSsm: vi.fn(async () => {
        throw new Error("timeout");
      }),
      scpUpload: vi.fn() as never,
      finalizeMove: vi.fn() as never,
      mutateConfig: mutate as never,
      print: vi.fn(),
      runtime: createDeterministicRuntime(),
    });

    await expect(cmd("./local", "/tmp/remote")).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("fails for non-running instance", async () => {
    const cmd = createCpCommand({
      stat: vi.fn(async () => ({ isFile: () => true, size: 12 })) as never,
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "stopped", instanceType: "t3" })),
      waitForSsm: vi.fn() as never,
      scpUpload: vi.fn() as never,
      finalizeMove: vi.fn() as never,
      mutateConfig: vi.fn() as never,
      print: vi.fn(),
      validateRemotePath: vi.fn(),
      runtime: createDeterministicRuntime(),
    });

    await expect(cmd("./local", "/tmp/remote")).rejects.toMatchObject({ code: "InstanceStateError" });
  });

  it("rejects control characters in remote path before transport", async () => {
    const scp = vi.fn();
    const cmd = createCpCommand({
      stat: vi.fn(async () => ({ isFile: () => true, size: 12 })) as never,
      readConfig: vi.fn() as never,
      describe: vi.fn() as never,
      waitForSsm: vi.fn() as never,
      scpUpload: scp as never,
      finalizeMove: vi.fn() as never,
      mutateConfig: vi.fn() as never,
      print: vi.fn(),
      runtime: createDeterministicRuntime(),
    });

    await expect(cmd("./local", "/tmp/remote\nfile")).rejects.toMatchObject({
      code: "ValidationError",
    });
    expect(scp).not.toHaveBeenCalled();
  });
});
