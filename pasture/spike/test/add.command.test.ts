import { describe, expect, it, vi } from "vitest";
import { createAddCommand } from "../src/cli/commands/add.js";
import { DevboxError } from "../src/domain/errors.js";
import { synthesizeFirstRunConfig } from "../src/domain/config-schema.js";

describe("add command contracts", () => {
  it("sets current to alias when current is absent", async () => {
    const cfg = synthesizeFirstRunConfig();
    const cmd = createAddCommand({
      validateAlias: vi.fn(),
      warnIfInstanceIdOdd: vi.fn(),
      describe: vi.fn(async () => ({ instanceId: "i-new", state: "running", instanceType: "t3.small" })),
      mutateConfig: vi.fn(async (mutator) => {
        const next = mutator(cfg);
        expect(next.current).toBe("newbox");
        return next;
      }) as never,
      print: vi.fn(),
    });

    await cmd("i-new", "newbox");
  });

  it("sets current only when absent", async () => {
    const printed: string[] = [];
    const cfg = synthesizeFirstRunConfig();
    cfg.current = "already";
    cfg.boxes.already = { instanceId: "i-old" };

    const cmd = createAddCommand({
      validateAlias: vi.fn(),
      warnIfInstanceIdOdd: vi.fn(),
      describe: vi.fn(async () => ({ instanceId: "i-new", state: "running", instanceType: "t3.small" })),
      mutateConfig: vi.fn(async (mutator) => {
        const next = mutator(cfg);
        expect(next.current).toBe("already");
        expect(next.boxes.newbox?.instanceId).toBe("i-new");
        return next;
      }) as never,
      print: (s) => printed.push(s),
    });

    await cmd("i-new", "newbox");
    expect(printed).toEqual(["i-new"]);
  });

  it("fails before mutation if AWS cannot describe instance", async () => {
    const mutate = vi.fn();
    const cmd = createAddCommand({
      validateAlias: vi.fn(),
      warnIfInstanceIdOdd: vi.fn(),
      describe: vi.fn(async () => {
        throw new DevboxError("NotFoundError", "missing");
      }),
      mutateConfig: mutate as never,
      print: vi.fn(),
    });

    await expect(cmd("i-x", "box")).rejects.toMatchObject({ code: "NotFoundError" });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("fails on duplicate alias", async () => {
    const cfg = synthesizeFirstRunConfig();
    cfg.boxes.box = { instanceId: "i-old" };
    const cmd = createAddCommand({
      validateAlias: vi.fn(),
      warnIfInstanceIdOdd: vi.fn(),
      describe: vi.fn(async () => ({ instanceId: "i-new", state: "running", instanceType: "t3.small" })),
      mutateConfig: vi.fn(async (mutator) => mutator(cfg)) as never,
      print: vi.fn(),
    });

    await expect(cmd("i-new", "box")).rejects.toMatchObject({ code: "ValidationError" });
  });

  it("calls alias and instance-id validation hooks", async () => {
    const validateAlias = vi.fn();
    const warnIfInstanceIdOdd = vi.fn();
    const cmd = createAddCommand({
      validateAlias,
      warnIfInstanceIdOdd,
      describe: vi.fn(async () => ({ instanceId: "i-new", state: "running", instanceType: "t3.small" })),
      mutateConfig: vi.fn(async (mutator) => mutator(synthesizeFirstRunConfig())) as never,
      print: vi.fn(),
    });

    await cmd("i-new", "box");
    expect(validateAlias).toHaveBeenCalledWith("box");
    expect(warnIfInstanceIdOdd).toHaveBeenCalledWith("i-new");
  });
});
