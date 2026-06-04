import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseAlias, ensureAliasAvailable } from "../../src/domain/alias.js";
import type { BoxAlias, InstanceId } from "../../src/domain/types.js";

interface AliasModel {
  boxes: Record<string, string>;
  current?: string;
}

type Cmd =
  | { type: "add"; alias: string; instanceId: string }
  | { type: "rm"; alias: string }
  | { type: "switch"; alias: string };

function applyCmd(model: AliasModel, cmd: Cmd): AliasModel {
  switch (cmd.type) {
    case "add": {
      const parsed = parseAlias(cmd.alias);
      if (!parsed.ok) return model;
      const available = ensureAliasAvailable(
        parsed.value,
        model.boxes as Record<BoxAlias, unknown>,
      );
      if (!available.ok) return model;
      return {
        boxes: { ...model.boxes, [cmd.alias]: cmd.instanceId },
        current: cmd.alias,
      };
    }
    case "rm": {
      if (!(cmd.alias in model.boxes)) return model;
      const { [cmd.alias]: _, ...rest } = model.boxes;
      return {
        boxes: rest,
        current: model.current === cmd.alias ? undefined : model.current,
      };
    }
    case "switch": {
      if (!(cmd.alias in model.boxes)) return model;
      return { ...model, current: cmd.alias };
    }
  }
}

const aliasArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,15}$/);
const instanceIdArb = fc.stringMatching(/^i-[0-9a-f]{17}$/);

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ type: fc.constant("add" as const), alias: aliasArb, instanceId: instanceIdArb }),
  fc.record({ type: fc.constant("rm" as const), alias: aliasArb }),
  fc.record({ type: fc.constant("switch" as const), alias: aliasArb }),
);

describe("alias-tracking state machine", () => {
  it("maintains alias uniqueness and current validity across command sequences", () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 1, maxLength: 30 }), (cmds) => {
        let model: AliasModel = { boxes: {}, current: undefined };

        for (const cmd of cmds) {
          model = applyCmd(model, cmd);

          // Invariant 1: no duplicate keys (guaranteed by Record, but check alias set)
          const aliases = Object.keys(model.boxes);
          expect(new Set(aliases).size).toBe(aliases.length);

          // Invariant 2: current is undefined or references existing alias
          if (model.current !== undefined) {
            expect(model.current in model.boxes).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("add with duplicate alias does not modify state", () => {
    fc.assert(
      fc.property(aliasArb, instanceIdArb, instanceIdArb, (alias, id1, id2) => {
        let model: AliasModel = { boxes: {}, current: undefined };
        model = applyCmd(model, { type: "add", alias, instanceId: id1 });
        const before = { ...model };
        model = applyCmd(model, { type: "add", alias, instanceId: id2 });
        expect(model.boxes[alias]).toBe(before.boxes[alias]);
      }),
      { numRuns: 200 },
    );
  });

  it("rm of current clears current", () => {
    fc.assert(
      fc.property(aliasArb, instanceIdArb, (alias, id) => {
        let model: AliasModel = { boxes: {}, current: undefined };
        model = applyCmd(model, { type: "add", alias, instanceId: id });
        expect(model.current).toBe(alias);
        model = applyCmd(model, { type: "rm", alias });
        expect(model.current).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });

  it("switch to existing alias sets current", () => {
    fc.assert(
      fc.property(aliasArb, aliasArb, instanceIdArb, instanceIdArb, (a1, a2, id1, id2) => {
        fc.pre(a1 !== a2);
        let model: AliasModel = { boxes: {}, current: undefined };
        model = applyCmd(model, { type: "add", alias: a1, instanceId: id1 });
        model = applyCmd(model, { type: "add", alias: a2, instanceId: id2 });
        model = applyCmd(model, { type: "switch", alias: a1 });
        expect(model.current).toBe(a1);
      }),
      { numRuns: 200 },
    );
  });
});
