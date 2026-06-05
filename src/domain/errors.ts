import type { Result } from "./result.js";
import { assertNever } from "./assert.js";

/**
 * Stable error categories for CLI contracts.
 *
 * @remarks
 * Each category maps to a fixed process exit code via `EXIT_CODE_BY_CATEGORY`.
 * New categories require updating the exit code map and CLI documentation.
 */
export type ErrorCategory =
  | "ValidationError"
  | "ConfigError"
  | "DependencyError"
  | "AwsCliError"
  | "NotFoundError"
  | "InstanceStateError"
  | "TimeoutError"
  | "ConsistencyError"
  | "TransportError";

interface ErrorBase<C extends ErrorCategory> {
  readonly category: C;
  readonly message: string;
  readonly details?: readonly string[];
}

export type ValidationError = ErrorBase<"ValidationError">;
export type ConfigError = ErrorBase<"ConfigError">;
export type DependencyError = ErrorBase<"DependencyError">;
export type AwsCliError = ErrorBase<"AwsCliError">;
export type NotFoundError = ErrorBase<"NotFoundError">;
export type InstanceStateError = ErrorBase<"InstanceStateError">;
export type TimeoutError = ErrorBase<"TimeoutError">;
export type ConsistencyError = ErrorBase<"ConsistencyError">;
export type TransportError = ErrorBase<"TransportError">;

type ErrorByCategory = {
  readonly ValidationError: ValidationError;
  readonly ConfigError: ConfigError;
  readonly DependencyError: DependencyError;
  readonly AwsCliError: AwsCliError;
  readonly NotFoundError: NotFoundError;
  readonly InstanceStateError: InstanceStateError;
  readonly TimeoutError: TimeoutError;
  readonly ConsistencyError: ConsistencyError;
  readonly TransportError: TransportError;
};

/**
 * Structured error value carried across domain and adapter boundaries.
 *
 * @remarks
 * Invariant: `category` is always one of the `ErrorCategory` literals.
 * `message` is always a non-empty human-readable summary.
 * `details`, when present, is a non-empty array of diagnostic strings.
 * Mutability: all fields are readonly.
 */
export type DevboxError = ErrorByCategory[keyof ErrorByCategory];

export type ProcessError = DependencyError | TransportError;
export type AwsReadError = DependencyError | AwsCliError | NotFoundError;
export type AwsWriteError = DependencyError | AwsCliError | NotFoundError;
export type RegistryResolutionError = ValidationError | ConfigError;
export type RemoteTransportError = DependencyError | TransportError;
export type RemoteAccessPreconditionError =
  | ConfigError
  | ValidationError
  | AwsCliError
  | NotFoundError
  | InstanceStateError
  | TimeoutError
  | DependencyError
  | TransportError;

/**
 * Exit code map required by the specification.
 *
 * @remarks
 * Invariant: all `ErrorCategory` values have a corresponding non-zero exit code.
 * Codes 2–10 are reserved; code 1 is reserved for unexpected failures.
 */
export const EXIT_CODE_BY_CATEGORY: Readonly<Record<ErrorCategory, number>> = {
  ValidationError: 2,
  ConfigError: 3,
  DependencyError: 4,
  AwsCliError: 5,
  NotFoundError: 6,
  InstanceStateError: 7,
  TimeoutError: 8,
  ConsistencyError: 9,
  TransportError: 10,
};

/**
 * Build a typed DevboxError value.
 *
 * @param category - error category used for user contract and exit code
 * @param message - concise human-readable summary
 * @param details - optional diagnostic detail lines
 * @returns structured error object with the provided fields
 *
 * @remarks
 * Precondition: `category` is a valid `ErrorCategory`; `message` is non-empty.
 * Postcondition: returned object has `details` key only when `details` argument is defined.
 * Invariant: does not throw; always returns a well-formed `DevboxError`.
 *
 * @example
 * ```ts
 * import { makeError } from "./errors.js";
 *
 * const error = makeError("ValidationError", "alias is invalid", [
 *   "must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
 * ]);
 * // error.category === "ValidationError"
 * // error.details?.length === 1
 * ```
 */
export function makeError(
  category: ErrorCategory,
  message: string,
  details?: readonly string[],
): DevboxError {
  if (details === undefined) {
    return { category, message };
  }
  return { category, message, details };
}

export function makeTypedError<C extends ErrorCategory>(
  category: C,
  message: string,
  details?: readonly string[],
): ErrorByCategory[C] {
  if (details === undefined) {
    return { category, message } as ErrorByCategory[C];
  }
  return { category, message, details } as ErrorByCategory[C];
}

/**
 * Render stderr lines in normalized format.
 *
 * @param error - structured error to render
 * @returns array with a summary line followed by optional indented detail lines
 *
 * @remarks
 * Precondition: `error` is a well-formed `DevboxError`.
 * Postcondition: first line matches `[devbox] <category>: <message>`;
 * subsequent lines are indented with two spaces.
 * Invariant: returned array always has at least one element.
 *
 * @example
 * ```ts
 * import { makeError, renderErrorLines } from "./errors.js";
 *
 * const lines = renderErrorLines(makeError("ConfigError", "missing field", ["details here"]));
 * // lines[0] === "[devbox] ConfigError: missing field"
 * // lines[1] === "  details here"
 * ```
 */
export function renderErrorLines(error: DevboxError): readonly string[] {
  const lines: string[] = [`[devbox] ${error.category}: ${error.message}`];
  if (error.details) {
    for (const detail of error.details) {
      lines.push(`  ${detail}`);
    }
  }
  return lines;
}

/**
 * Compute process exit code for a normalized error.
 *
 * @param error - normalized error with a valid category
 * @returns stable non-zero CLI exit code (2–10)
 *
 * @remarks
 * Precondition: `error.category` is a member of `ErrorCategory`.
 * Postcondition: returned value is in the range [2, 10].
 * Invariant: mapping is deterministic and stable across versions.
 *
 * @example
 * ```ts
 * import { makeError, exitCodeForError } from "./errors.js";
 *
 * const code = exitCodeForError(makeError("TimeoutError", "timed out"));
 * // code === 8
 * ```
 */
export function exitCodeForError(error: DevboxError): number {
  return EXIT_CODE_BY_CATEGORY[error.category];
}

export function mapProcessErrorToDependencyOrTransport(error: ProcessError): DependencyError | TransportError {
  switch (error.category) {
    case "DependencyError":
      return error;
    case "TransportError":
      return error;
    default:
      return assertNever(error);
  }
}

/**
 * Type guard for Result failure branch.
 *
 * @param value - Result value to test
 * @returns `true` when Result is in the failure branch (`ok === false`)
 *
 * @remarks
 * Precondition: `value` is a valid `Result<T, E>`.
 * Postcondition: when `true`, TypeScript narrows `value` to `{ ok: false; error: E }`.
 * Invariant: does not throw; pure predicate.
 *
 * @example
 * ```ts
 * import { isError } from "./errors.js";
 * import { err } from "./result.js";
 *
 * const result = err(makeError("NotFoundError", "not found"));
 * if (isError(result)) {
 *   // result.error is narrowed here
 * }
 * ```
 */
export function isError<T, E>(value: Result<T, E>): value is { readonly ok: false; readonly error: E } {
  return !value.ok;
}
