import { describe, expect, it, vi } from "vitest";
import { createRmCommand } from "../src/cli/commands/rm.js";
import { synthesizeFirstRunConfig } from "../src/domain/config-schema.js";
import { DevboxError } from "../src/domain/errors.js";

describe("rm command contracts", () => {
  it("local-only rm removes alias, clears current, prints warning", async () => {
    const warnings: string[] = [];
    const prints: string[] = [];
    const cfg = synthesizeFirstRunConfig();
    cfg.current = "work";
    cfg.boxes.work = { instanceId: "i-1" };

    const cmd = createRmCommand({
      readConfig: vi.fn(async () => cfg),
      terminate: vi.fn(async () => {}),
      mutateConfig: vi.fn(async (mutator) => {
        const next = mutator(cfg);
        expect(next.boxes.work).toBeUndefined();
        expect(next.current).toBeUndefined();
        return next;
      }) as never,
      warn: (s) => warnings.push(s),
      print: (s) => prints.push(s),
    });

    await cmd("work", false);
    expect(warnings.join(" ")).toContain("AWS resources may still exist");
    expect(prints).toEqual(["work"]);
  });

  it("terminate path calls AWS before local mutation", async () => {
    const callOrder: string[] = [];
    const cfg = synthesizeFirstRunConfig();
    cfg.boxes.work = { instanceId: "i-1" };

    const cmd = createRmCommand({
      readConfig: vi.fn(async () => cfg),
      terminate: vi.fn(async () => {
        callOrder.push("terminate");
      }),
      mutateConfig: vi.fn(async (mutator) => {
        callOrder.push("mutate");
        return mutator(cfg);
      }) as never,
      warn: vi.fn(),
      print: vi.fn(),
    });

    await cmd("work", true);
    expect(callOrder).toEqual(["terminate", "mutate"]);
  });

  it("does not mutate if terminate fails", async () => {
    const mutate = vi.fn();
    const cfg = synthesizeFirstRunConfig();
    cfg.boxes.work = { instanceId: "i-1" };

    const cmd = createRmCommand({
      readConfig: vi.fn(async () => cfg),
      terminate: vi.fn(async () => {
        throw new DevboxError("AwsCliError", "denied");
      }),
      mutateConfig: mutate as never,
      warn: vi.fn(),
      print: vi.fn(),
    });

    await expect(cmd("work", true)).rejects.toMatchObject({ code: "AwsCliError" });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("fails when alias does not exist", async () => {
    const cmd = createRmCommand({
      readConfig: vi.fn(async () => synthesizeFirstRunConfig()),
      terminate: vi.fn() as never,
      mutateConfig: vi.fn() as never,
      warn: vi.fn(),
      print: vi.fn(),
    });

    await expect(cmd("missing", false)).rejects.toMatchObject({ code: "NotFoundError" });
  });

  it("does not warn in terminate mode", async () => {
    const warn = vi.fn();
    const cfg = synthesizeFirstRunConfig();
    cfg.boxes.work = { instanceId: "i-1" };

    const cmd = createRmCommand({
      readConfig: vi.fn(async () => cfg),
      terminate: vi.fn(async () => {}),
      mutateConfig: vi.fn(async (mutator) => mutator(cfg)) as never,
      warn,
      print: vi.fn(),
    });

    await cmd("work", true);
    expect(warn).not.toHaveBeenCalled();
  });
});
