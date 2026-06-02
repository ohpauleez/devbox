import { describe, expect, it, vi } from "vitest";
import { createConnectCommand } from "../src/cli/commands/connect.js";
import { synthesizeFirstRunConfig } from "../src/domain/config-schema.js";
import { createDeterministicRuntime } from "./helpers/runtime.js";

function cfgWithCurrent() {
  const cfg = synthesizeFirstRunConfig();
  cfg.current = "work";
  cfg.boxes.work = { instanceId: "i-1" };
  return cfg;
}

describe("connect command contracts", () => {
  it("requires running instance and updates lastConnectAt only on success", async () => {
    const cfg = cfgWithCurrent();
    let nextCfg = cfg;
    const cmd = createConnectCommand({
      readConfig: vi.fn(async () => cfg),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "running", instanceType: "t3" })),
      waitForSsm: vi.fn(async () => {}),
      connect: vi.fn(async () => {}),
      runtime: createDeterministicRuntime({ nowIso: ["2026-06-01T09:00:00.000Z"] }),
      mutateConfig: vi.fn(async (mutator) => {
        nextCfg = mutator(nextCfg);
        return nextCfg;
      }) as never,
    });

    await cmd();
    expect(nextCfg.boxes.work?.lastConnectAt).toBe("2026-06-01T09:00:00.000Z");
  });

  it("does not mutate config when connection startup fails", async () => {
    const cfg = cfgWithCurrent();
    const mutate = vi.fn();
    const cmd = createConnectCommand({
      readConfig: vi.fn(async () => cfg),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "running", instanceType: "t3" })),
      waitForSsm: vi.fn(async () => {}),
      connect: vi.fn(async () => {
        throw new Error("ssh fail");
      }),
      runtime: createDeterministicRuntime(),
      mutateConfig: mutate as never,
    });

    await expect(cmd()).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("fails for non-running instance", async () => {
    const waitForSsm = vi.fn();
    const connect = vi.fn();
    const cmd = createConnectCommand({
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "stopped", instanceType: "t3" })),
      waitForSsm: waitForSsm as never,
      connect: connect as never,
      mutateConfig: vi.fn() as never,
      runtime: createDeterministicRuntime(),
    });
    await expect(cmd()).rejects.toMatchObject({ code: "InstanceStateError" });
    expect(waitForSsm).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("does not mutate config when SSM readiness fails", async () => {
    const mutate = vi.fn();
    const cmd = createConnectCommand({
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "running", instanceType: "t3" })),
      waitForSsm: vi.fn(async () => {
        throw new Error("timeout");
      }),
      connect: vi.fn() as never,
      mutateConfig: mutate as never,
      runtime: createDeterministicRuntime(),
    });

    await expect(cmd()).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
  });
});
