import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseConfig, serializeConfig } from "../../src/domain/config-schema.js";
import { BUILTIN_REQUIRED_TAG_DEFAULTS } from "../../src/domain/tags.js";
import type { BoxAlias, BoxConfig, DevboxConfig, InstanceId, SshUser } from "../../src/domain/types.js";

const aliasArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,15}$/);
const instanceIdArb = fc.stringMatching(/^i-[0-9a-f]{17}$/);
const sshUserArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,7}$/);

const boxConfigArb: fc.Arbitrary<BoxConfig> = fc.record({
  instanceId: instanceIdArb.map((id) => id as InstanceId),
  sshUser: fc.option(sshUserArb.map((u) => u as SshUser), { nil: undefined }),
});

const configArb: fc.Arbitrary<DevboxConfig> = fc
  .array(fc.tuple(aliasArb, boxConfigArb), { minLength: 0, maxLength: 5 })
  .chain((entries) => {
    // Deduplicate aliases
    const boxesMap = new Map<string, BoxConfig>();
    for (const [alias, box] of entries) {
      if (!boxesMap.has(alias)) boxesMap.set(alias, box);
    }
    const boxes = Object.fromEntries(boxesMap) as Record<BoxAlias, BoxConfig>;
    const aliases = [...boxesMap.keys()];

    const currentArb =
      aliases.length > 0
        ? fc.option(fc.constantFrom(...aliases), { nil: undefined })
        : fc.constant(undefined);

    return currentArb.map((current) => ({
      boxes,
      defaults: { tags: BUILTIN_REQUIRED_TAG_DEFAULTS },
      ...(current !== undefined ? { current: current as BoxAlias } : {}),
    }));
  });

describe("config-store round-trip", () => {
  it("serializeConfig -> JSON.parse -> parseConfig equals original", () => {
    fc.assert(
      fc.property(configArb, (config) => {
        const serialized = serializeConfig(config);
        const raw = JSON.parse(serialized);
        const result = parseConfig(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.boxes).toEqual(config.boxes);
          expect(result.value.defaults).toEqual(config.defaults);
          expect(result.value.current).toEqual(config.current);
        }
      }),
      { numRuns: 200 },
    );
  });
});
