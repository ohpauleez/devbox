import { describe, expect, it } from "vitest";
import {
  parseConfig,
  serializeConfig,
  synthesizeFirstRunConfig,
} from "../../src/domain/config-schema.js";
import { BUILTIN_REQUIRED_TAG_DEFAULTS } from "../../src/domain/tags.js";
import type { DevboxConfig } from "../../src/domain/types.js";

const validConfig = {
  boxes: { mybox: { instanceId: "i-abc123" } },
  defaults: {
    tags: {
      env: "dev",
      service: "devbox",
      version: "0000000",
      "customer-data": "false",
      team: "devbox",
    },
  },
  current: "mybox",
};

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    const result = parseConfig(validConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value.boxes as Record<string, unknown>)["mybox"]).toEqual({ instanceId: "i-abc123" });
      expect(result.value.current).toBe("mybox");
    }
  });

  it("rejects non-object", () => {
    const result = parseConfig("string");
    expect(result.ok).toBe(false);
  });

  it("rejects missing boxes", () => {
    const result = parseConfig({ defaults: validConfig.defaults });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("ConfigError");
  });

  it("rejects missing defaults", () => {
    const result = parseConfig({ boxes: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("ConfigError");
  });

  it("rejects missing required tags", () => {
    const result = parseConfig({
      boxes: {},
      defaults: { tags: { env: "dev" } },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects wrong tag values (invalid env)", () => {
    const result = parseConfig({
      boxes: {},
      defaults: {
        tags: { ...validConfig.defaults.tags, env: "production" },
      },
    });
    expect(result.ok).toBe(false);
  });

  describe("current field", () => {
    it("current absent is fine", () => {
      const result = parseConfig({
        boxes: { mybox: { instanceId: "i-abc123" } },
        defaults: validConfig.defaults,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.current).toBeUndefined();
    });

    it("current pointing to missing alias rejects", () => {
      const result = parseConfig({
        boxes: { mybox: { instanceId: "i-abc123" } },
        defaults: validConfig.defaults,
        current: "noexist",
      });
      expect(result.ok).toBe(false);
    });

    it("current pointing to existing alias passes", () => {
      const result = parseConfig(validConfig);
      expect(result.ok).toBe(true);
    });
  });
});

describe("synthesizeFirstRunConfig", () => {
  it("returns empty boxes", () => {
    const config = synthesizeFirstRunConfig();
    expect(Object.keys(config.boxes)).toHaveLength(0);
  });

  it("has valid defaults with built-in tag defaults", () => {
    const config = synthesizeFirstRunConfig();
    expect(config.defaults.tags).toEqual(BUILTIN_REQUIRED_TAG_DEFAULTS);
  });

  it("has no current", () => {
    const config = synthesizeFirstRunConfig();
    expect(config.current).toBeUndefined();
  });
});

describe("serialization round-trip", () => {
  it("parseConfig(JSON.parse(serializeConfig(config))) === config", () => {
    const original = parseConfig(validConfig);
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const serialized = serializeConfig(original.value);
    const roundTripped = parseConfig(JSON.parse(serialized));
    expect(roundTripped.ok).toBe(true);
    if (roundTripped.ok) {
      expect(roundTripped.value).toEqual(original.value);
    }
  });

  it("serialized output ends with newline", () => {
    const config = synthesizeFirstRunConfig();
    const serialized = serializeConfig(config);
    expect(serialized.endsWith("\n")).toBe(true);
  });
});
