import { describe, expect, it } from "vitest";
import fc from "fast-check";

type Model = {
  boxes: Set<string>;
  current?: string;
};

type Op =
  | { kind: "add"; alias: string }
  | { kind: "switch"; alias: string }
  | { kind: "rm"; alias: string };

function step(model: Model, op: Op): Model {
  const boxes = new Set(model.boxes);
  let current = model.current;

  if (op.kind === "add") {
    boxes.add(op.alias);
    current = op.alias;
  } else if (op.kind === "switch") {
    if (boxes.has(op.alias)) {
      current = op.alias;
    }
  } else {
    boxes.delete(op.alias);
    if (current === op.alias) {
      current = undefined;
    }
  }

  return { boxes, current };
}

describe("state invariants property", () => {
  it("current is absent or points to existing alias", () => {
    const aliasArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,10}$/);
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      aliasArb.map((alias) => ({ kind: "add" as const, alias })),
      aliasArb.map((alias) => ({ kind: "switch" as const, alias })),
      aliasArb.map((alias) => ({ kind: "rm" as const, alias })),
    );

    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 200 }), (ops) => {
        let model: Model = { boxes: new Set<string>() };
        for (const op of ops) {
          model = step(model, op);
          if (model.current !== undefined) {
            expect(model.boxes.has(model.current)).toBe(true);
          }
        }
      }),
    );
  });
});
