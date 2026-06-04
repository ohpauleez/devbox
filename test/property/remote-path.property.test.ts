import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseRemotePath } from "../../src/domain/remote-path.js";

describe("parseRemotePath", () => {
  it("succeeds for non-empty strings without control chars", () => {
    const safeStr = fc
      .string({ minLength: 1 })
      .filter((s) => s.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(s));

    fc.assert(
      fc.property(safeStr, (s) => {
        const result = parseRemotePath(s);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(s.trim());
        }
      }),
      { numRuns: 200 },
    );
  });

  it("fails for strings containing control characters", () => {
    const controlChar = fc.integer({ min: 0, max: 31 }).map((n) => String.fromCharCode(n));
    const withControl = fc
      .tuple(fc.string(), controlChar, fc.string())
      .map(([a, c, b]) => a + c + b);

    fc.assert(
      fc.property(withControl, (s) => {
        const result = parseRemotePath(s);
        // If after trim the control char is still present, it must fail
        if (/[\x00-\x1f\x7f]/.test(s.trim()) && s.trim().length > 0) {
          expect(result.ok).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("fails for empty or whitespace-only strings", () => {
    const whitespace = fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r"));

    fc.assert(
      fc.property(whitespace, (s) => {
        const result = parseRemotePath(s);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
