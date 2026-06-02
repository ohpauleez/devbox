import { describe, expect, it } from "vitest";
import { parseConfigOrThrow, synthesizeFirstRunConfig } from "../src/domain/config-schema.js";

describe("config schema", () => {
  it("creates first-run config with required defaults", () => {
    const cfg = synthesizeFirstRunConfig();
    expect(cfg.current).toBeUndefined();
    expect(cfg.boxes).toEqual({});
    expect(cfg.defaults.tags.service).toBe("devbox");
  });

  it("rejects invalid current references", () => {
    expect(() =>
      parseConfigOrThrow({
        current: "missing",
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
      }),
    ).toThrow();
  });
});
