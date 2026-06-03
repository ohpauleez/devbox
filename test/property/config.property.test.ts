import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { parseAlias } from "../../src/domain/alias.js";

describe("alias properties", () => {
  it("accepts only aliases up to 64 chars with allowed charset", () => {
    fc.assert(
      fc.property(fc.string(), (candidate) => {
        const result = parseAlias(candidate);
        const expected = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(candidate);
        expect(result.ok).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });
});
