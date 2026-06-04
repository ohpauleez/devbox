import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolveSshUser } from "../../src/domain/ssh-user.js";
import type { BoxConfig, DefaultsConfig, InstanceId, SshUser } from "../../src/domain/types.js";
import { BUILTIN_REQUIRED_TAG_DEFAULTS } from "../../src/domain/tags.js";

const sshUserStr = fc.stringMatching(/^[a-z][a-z0-9_-]{0,7}$/);
const emptyDefaults: DefaultsConfig = { tags: BUILTIN_REQUIRED_TAG_DEFAULTS };
const emptyBox: BoxConfig = { instanceId: "i-00000000000000000" as InstanceId };

describe("resolveSshUser precedence", () => {
  it("invocationOverride takes highest precedence", () => {
    fc.assert(
      fc.property(sshUserStr, sshUserStr, sshUserStr, (override, boxUser, defaultUser) => {
        const result = resolveSshUser({
          invocationOverride: override,
          box: { ...emptyBox, sshUser: boxUser as SshUser },
          defaults: { ...emptyDefaults, sshUser: defaultUser as SshUser },
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(override.trim());
        }
      }),
      { numRuns: 200 },
    );
  });

  it("box.sshUser used when invocationOverride is empty", () => {
    fc.assert(
      fc.property(sshUserStr, sshUserStr, (boxUser, defaultUser) => {
        const result = resolveSshUser({
          invocationOverride: "",
          box: { ...emptyBox, sshUser: boxUser as SshUser },
          defaults: { ...emptyDefaults, sshUser: defaultUser as SshUser },
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(boxUser);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("defaults.sshUser used when invocation and box are missing", () => {
    fc.assert(
      fc.property(sshUserStr, (defaultUser) => {
        const result = resolveSshUser({
          box: emptyBox,
          defaults: { ...emptyDefaults, sshUser: defaultUser as SshUser },
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(defaultUser);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("returns error when all sources are missing", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const result = resolveSshUser({
          box: emptyBox,
          defaults: emptyDefaults,
        });
        expect(result.ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects invocation override containing embedded control characters", () => {
    // Generate strings where invalid chars appear BETWEEN valid chars,
    // so trim() cannot remove them. These must be rejected.
    const badUserArb = fc.tuple(
      fc.stringMatching(/^[a-z]{1,4}$/),
      fc.constantFrom("\x00", "\x01", "\x1f", "\x7f", "\t", " "),
      fc.stringMatching(/^[a-z]{1,4}$/),
    ).map(([prefix, bad, suffix]) => `${prefix}${bad}${suffix}`);

    fc.assert(
      fc.property(badUserArb, (badUser) => {
        const result = resolveSshUser({
          invocationOverride: badUser,
          box: emptyBox,
          defaults: emptyDefaults,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.category).toBe("ValidationError");
        }
      }),
      { numRuns: 200 },
    );
  });
});
