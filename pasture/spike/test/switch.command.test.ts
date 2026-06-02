import { describe, expect, it, vi } from "vitest";
import { createSwitchCommand } from "../src/cli/commands/switch.js";
import { synthesizeFirstRunConfig } from "../src/domain/config-schema.js";
import { DevboxError } from "../src/domain/errors.js";

describe("switch command contracts", () => {
  it("sets current to selected alias and prints alias", async () => {
    const cfg = synthesizeFirstRunConfig();
    cfg.boxes.work = { instanceId: "i-1" };
    const printed: string[] = [];

    const cmd = createSwitchCommand({
      mutateConfig: vi.fn(async (mutator) => {
        const next = mutator(cfg);
        expect(next.current).toBe("work");
        return next;
      }) as never,
      print: (s) => printed.push(s),
    });

    await cmd("work");
    expect(printed).toEqual(["work"]);
  });

  it("fails when alias does not exist and does not print", async () => {
    const cfg = synthesizeFirstRunConfig();
    const printed = vi.fn();
    const cmd = createSwitchCommand({
      mutateConfig: vi.fn(async (mutator) => mutator(cfg)) as never,
      print: printed,
    });

    await expect(cmd("missing")).rejects.toMatchObject({ code: "NotFoundError" });
    expect(printed).not.toHaveBeenCalled();
  });
});
