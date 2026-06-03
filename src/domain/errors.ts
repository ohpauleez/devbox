import type { Result } from "./result.js";

/**
 * Stable error categories for CLI contracts.
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

/**
 * Structured error value carried across domain and adapter boundaries.
 */
export interface DevboxError {
  readonly category: ErrorCategory;
  readonly message: string;
  readonly details?: readonly string[];
}

/**
 * Exit code map required by the specification.
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
 * @param category error category used for user contract and exit code
 * @param message concise human-readable summary
 * @param details optional diagnostic detail lines
 * @returns structured error object
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

/**
 * Render stderr lines in normalized format.
 *
 * @param error structured error to render
 * @returns first summary line and optional indented detail lines
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
 * @param error normalized error
 * @returns stable non-zero CLI exit code
 */
export function exitCodeForError(error: DevboxError): number {
  return EXIT_CODE_BY_CATEGORY[error.category];
}

/**
 * Type guard for Result failure branch.
 *
 * @param value Result value
 * @returns true when Result is failure branch
 */
export function isError<T, E>(value: Result<T, E>): value is { readonly ok: false; readonly error: E } {
  return !value.ok;
}
