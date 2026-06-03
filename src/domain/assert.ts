/**
 * Exhaustiveness helper for closed discriminated unions.
 *
 * @param value unexpected value
 * @throws {Error} always throws because this state is impossible
 */
export function assertNever(value: never): never {
  throw new Error(`Unreachable value: ${String(value)}`);
}
