import { describe, expect, it } from "vitest";
import { ALIAS_REGEX, validateAlias } from "../src/domain/alias.js";

describe("alias validation", () => {
  it("accepts valid aliases", () => {
    expect(ALIAS_REGEX.test("workbox")).toBe(true);
    expect(() => validateAlias("workbox-1_a")).not.toThrow();
  });

  it("rejects invalid aliases", () => {
    expect(() => validateAlias("-bad")).toThrow();
    expect(() => validateAlias("bad alias")).toThrow();
    expect(() => validateAlias("x".repeat(65))).toThrow();
  });
});
