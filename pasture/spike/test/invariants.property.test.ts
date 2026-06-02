import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseConfigOrThrow, synthesizeFirstRunConfig } from "../src/domain/config-schema.js";

describe("global invariants properties", () => {
  it("committed config states remain schema-valid and current points to existing alias", () => {
    const aliasArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,10}$/);
    const opArb = fc.oneof(
      aliasArb.map((alias) => ({ k: "add" as const, alias })),
      aliasArb.map((alias) => ({ k: "switch" as const, alias })),
      aliasArb.map((alias) => ({ k: "rm" as const, alias })),
    );

    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 200 }), (ops) => {
        let cfg = synthesizeFirstRunConfig();
        for (const op of ops) {
          if (op.k === "add") {
            cfg = {
              ...cfg,
              boxes: {
                ...cfg.boxes,
                [op.alias]: { instanceId: "i-12345678" },
              },
              current: cfg.current ?? op.alias,
            };
          } else if (op.k === "switch") {
            if (cfg.boxes[op.alias]) {
              cfg = { ...cfg, current: op.alias };
            }
          } else {
            if (cfg.boxes[op.alias]) {
              const next = { ...cfg.boxes };
              delete next[op.alias];
              cfg = {
                ...cfg,
                boxes: next,
                current: cfg.current === op.alias ? undefined : cfg.current,
              };
            }
          }

          const validated = parseConfigOrThrow(cfg);
          if (validated.current) {
            expect(validated.boxes[validated.current]).toBeDefined();
          }
        }
      }),
    );
  });
});
