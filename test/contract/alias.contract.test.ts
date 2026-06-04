import { describe, expect, it } from "vitest";
import {
  parseAlias,
  ensureAliasAvailable,
  matchesInstanceIdAdvisoryPattern,
} from "../../src/domain/alias.js";
import type { BoxAlias } from "../../src/domain/types.js";

describe("parseAlias", () => {
  describe("valid aliases", () => {
    it.each(["mybox", "a", "A1-test_2", "a".repeat(64)])(
      "accepts %s",
      (alias) => {
        const result = parseAlias(alias);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toBe(alias);
      },
    );
  });

  describe("invalid aliases", () => {
    it.each([
      ["empty string", ""],
      ["starts with _", "_box"],
      ["starts with -", "-box"],
      ["65 chars", "a".repeat(65)],
      ["special chars", "my@box"],
      ["spaces", "my box"],
    ])("rejects %s", (_label, alias) => {
      const result = parseAlias(alias);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.category).toBe("ValidationError");
    });
  });
});

describe("ensureAliasAvailable", () => {
  const tracked = { mybox: { instanceId: "i-123" } } as unknown as Record<BoxAlias, unknown>;

  it("passes for new alias", () => {
    const result = ensureAliasAvailable("newbox" as BoxAlias, tracked);
    expect(result.ok).toBe(true);
  });

  it("fails for existing alias", () => {
    const result = ensureAliasAvailable("mybox" as BoxAlias, tracked);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("already tracked");
  });
});

describe("matchesInstanceIdAdvisoryPattern", () => {
  it("matches i-abcdef12 (8 hex)", () => {
    expect(matchesInstanceIdAdvisoryPattern("i-abcdef12")).toBe(true);
  });

  it("matches i-abcdef1234567890a (17 hex)", () => {
    expect(matchesInstanceIdAdvisoryPattern("i-abcdef1234567890a")).toBe(true);
  });

  it("does not match x-123", () => {
    expect(matchesInstanceIdAdvisoryPattern("x-123")).toBe(false);
  });

  it("does not match i-12345 (wrong length)", () => {
    expect(matchesInstanceIdAdvisoryPattern("i-12345")).toBe(false);
  });
});
