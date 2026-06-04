/**
 * Exhaustiveness helper for closed discriminated unions.
 *
 * @param value - unexpected value; TypeScript narrows this to `never` when all
 *   union branches have been handled
 * @returns never — this function always throws
 *
 * @throws {Error} Always throws because reaching this code path implies a logic
 *   error: a discriminated union branch was not handled by the caller.
 *
 * @remarks
 * Precondition: all valid branches of the union must be handled before this call.
 * Postcondition: execution never continues past this call — always throws.
 * Safety: if a new variant is added to a union, TypeScript will report a compile
 * error at the call site because `value` will no longer narrow to `never`.
 *
 * @example
 * ```ts
 * import { assertNever } from "./assert.js";
 *
 * type Direction = "up" | "down";
 *
 * function describe(d: Direction): string {
 *   switch (d) {
 *     case "up": return "ascending";
 *     case "down": return "descending";
 *     default: return assertNever(d);
 *   }
 * }
 * ```
 */
export function assertNever(value: never): never {
  throw new Error(`Unreachable value: ${String(value)}`);
}
