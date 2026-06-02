import { describe, expect, it, vi } from "vitest";
import { createListCommand } from "../src/cli/commands/list.js";
import { DevboxError } from "../src/domain/errors.js";

describe("list command contracts", () => {
  it("prints No boxes tracked when empty", async () => {
    const printNoBoxes = vi.fn();
    const printTable = vi.fn();
    const cmd = createListCommand({
      readConfig: vi.fn(async () => ({
        boxes: {},
        defaults: {
          tags: {
            env: "dev",
            service: "devbox",
            version: "0000000",
            "customer-data": "false",
            team: "engineering",
          },
        },
      })),
      describeMany: vi.fn() as never,
      printNoBoxes,
      printTable,
    });

    await cmd();
    expect(printNoBoxes).toHaveBeenCalledOnce();
    expect(printTable).not.toHaveBeenCalled();
  });

  it("maps NotFound to stale and aws/dependency errors to unknown", async () => {
    const printTable = vi.fn();
    const cmd = createListCommand({
      readConfig: vi.fn(async () => ({
        current: "a",
        boxes: {
          a: { instanceId: "i-a" },
          b: { instanceId: "i-b" },
        },
        defaults: {
          tags: {
            env: "dev",
            service: "devbox",
            version: "0000000",
            "customer-data": "false",
            team: "engineering",
          },
        },
      })),
      describeMany: vi.fn(async () => {
        throw new DevboxError("AwsCliError", "unavailable");
      }),
      printNoBoxes: vi.fn(),
      printTable,
    });

    await cmd();
    const rows = printTable.mock.calls[0]?.[0] ?? [];
    expect(rows.find((r: { alias: string }) => r.alias === "a")?.state).toBe("unknown");
    expect(rows.find((r: { alias: string }) => r.alias === "b")?.state).toBe("unknown");
  });

  it("propagates non-AWS unexpected errors", async () => {
    const cmd = createListCommand({
      readConfig: vi.fn(async () => ({
        boxes: { a: { instanceId: "i-a" } },
        defaults: {
          tags: {
            env: "dev",
            service: "devbox",
            version: "0000000",
            "customer-data": "false",
            team: "engineering",
          },
        },
      })),
      describeMany: vi.fn(async () => {
        throw new Error("boom");
      }),
      printNoBoxes: vi.fn(),
      printTable: vi.fn(),
    });

    await expect(cmd()).rejects.toThrow("boom");
  });

  it("marks omitted instances as stale on successful enrichment", async () => {
    const printTable = vi.fn();
    const cmd = createListCommand({
      readConfig: vi.fn(async () => ({
        current: "a",
        boxes: {
          a: { instanceId: "i-a" },
          b: { instanceId: "i-b" },
        },
        defaults: {
          tags: {
            env: "dev",
            service: "devbox",
            version: "0000000",
            "customer-data": "false",
            team: "engineering",
          },
        },
      })),
      describeMany: vi.fn(async () =>
        new Map([
          ["i-a", { instanceId: "i-a", state: "running", instanceType: "t3" }],
        ]),
      ),
      printNoBoxes: vi.fn(),
      printTable,
    });

    await cmd();
    const rows = printTable.mock.calls[0]?.[0] ?? [];
    expect(rows.find((r: { alias: string }) => r.alias === "a")?.state).toBe("running");
    expect(rows.find((r: { alias: string }) => r.alias === "b")?.state).toBe("stale");
  });

  it("batches describe calls to 1000 IDs", async () => {
    const boxes: Record<string, { instanceId: string }> = {};
    for (let i = 0; i < 1001; i += 1) {
      boxes[`a${i}`] = { instanceId: `i-${i}` };
    }
    const describeMany = vi.fn(async () => new Map());

    const cmd = createListCommand({
      readConfig: vi.fn(async () => ({
        boxes,
        defaults: {
          tags: {
            env: "dev",
            service: "devbox",
            version: "0000000",
            "customer-data": "false",
            team: "engineering",
          },
        },
      })),
      describeMany,
      printNoBoxes: vi.fn(),
      printTable: vi.fn(),
    });

    await cmd();
    expect(describeMany).toHaveBeenCalledTimes(2);
    expect(describeMany.mock.calls[0]?.[0]).toHaveLength(1000);
    expect(describeMany.mock.calls[1]?.[0]).toHaveLength(1);
  });
});
