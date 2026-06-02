import { describe, expect, it, vi } from "vitest";
import { createUpCommand } from "../src/cli/commands/up.js";
import { createDownCommand } from "../src/cli/commands/down.js";
import { synthesizeFirstRunConfig } from "../src/domain/config-schema.js";

function cfgWithCurrent(): ReturnType<typeof synthesizeFirstRunConfig> {
  const cfg = synthesizeFirstRunConfig();
  cfg.current = "work";
  cfg.boxes.work = { instanceId: "i-1" };
  return cfg;
}

describe("up/down contracts", () => {
  it("up from running succeeds immediately without start or wait", async () => {
    const start = vi.fn();
    const wait = vi.fn();
    const print = vi.fn();
    const cmd = createUpCommand({
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "running", instanceType: "t3" })),
      start: start as never,
      wait: wait as never,
      print,
    });

    await cmd();
    expect(start).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(print).toHaveBeenCalledWith("i-1");
  });

  it("up from stopped starts then waits", async () => {
    const calls: string[] = [];
    const cmd = createUpCommand({
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "stopped", instanceType: "t3" })),
      start: vi.fn(async () => {
        calls.push("start");
      }),
      wait: vi.fn(async () => {
        calls.push("wait");
      }) as never,
      print: vi.fn((s: string) => {
        calls.push(`print:${s}`);
      }),
    });
    await cmd();
    expect(calls).toEqual(["start", "wait", "print:i-1"]);
  });

  it("up from pending waits without start", async () => {
    const start = vi.fn();
    const wait = vi.fn(async () => {});
    const cmd = createUpCommand({
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "pending", instanceType: "t3" })),
      start: start as never,
      wait: wait as never,
      print: vi.fn(),
    });
    await cmd();
    expect(start).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledOnce();
  });

  it("down from running stops then waits", async () => {
    const calls: string[] = [];
    const cmd = createDownCommand({
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "running", instanceType: "t3" })),
      stop: vi.fn(async () => {
        calls.push("stop");
      }),
      wait: vi.fn(async () => {
        calls.push("wait");
      }) as never,
      print: vi.fn((s: string) => {
        calls.push(`print:${s}`);
      }),
    });
    await cmd();
    expect(calls).toEqual(["stop", "wait", "print:i-1"]);
  });

  it("down from stopping waits without stop", async () => {
    const stop = vi.fn();
    const wait = vi.fn(async () => {});
    const cmd = createDownCommand({
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "stopping", instanceType: "t3" })),
      stop: stop as never,
      wait: wait as never,
      print: vi.fn(),
    });
    await cmd();
    expect(stop).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledOnce();
  });

  it("rejects invalid starting states", async () => {
    const up = createUpCommand({
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "terminated", instanceType: "t3" })),
      start: vi.fn() as never,
      wait: vi.fn() as never,
      print: vi.fn(),
    });

    await expect(up()).rejects.toMatchObject({ code: "InstanceStateError" });
  });

  it("down from stopped succeeds immediately without stop or wait", async () => {
    const stop = vi.fn();
    const wait = vi.fn();
    const print = vi.fn();
    const cmd = createDownCommand({
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "stopped", instanceType: "t3" })),
      stop: stop as never,
      wait: wait as never,
      print,
    });

    await cmd();
    expect(stop).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(print).toHaveBeenCalledWith("i-1");
  });

  it("down rejects terminated state", async () => {
    const down = createDownCommand({
      readConfig: vi.fn(async () => cfgWithCurrent()),
      describe: vi.fn(async () => ({ instanceId: "i-1", state: "terminated", instanceType: "t3" })),
      stop: vi.fn() as never,
      wait: vi.fn() as never,
      print: vi.fn(),
    });

    await expect(down()).rejects.toMatchObject({ code: "InstanceStateError" });
  });
});
