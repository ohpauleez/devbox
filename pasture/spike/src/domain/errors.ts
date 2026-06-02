export type ErrorCodeName =
  | "ValidationError"
  | "ConfigError"
  | "DependencyError"
  | "AwsCliError"
  | "TransportError"
  | "NotFoundError"
  | "InstanceStateError"
  | "TimeoutError"
  | "ConsistencyError";

export const EXIT_CODES: Record<ErrorCodeName, number> = {
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

export class DevboxError extends Error {
  readonly code: ErrorCodeName;
  readonly details: string | undefined;

  constructor(code: ErrorCodeName, message: string, details?: string) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function normalizeError(err: unknown): DevboxError {
  if (err instanceof DevboxError) {
    return err;
  }

  if (err instanceof Error) {
    return new DevboxError("ValidationError", err.message);
  }

  return new DevboxError("ValidationError", "Unknown error");
}

export function printError(err: DevboxError): void {
  process.stderr.write(`${err.code}: ${err.message}\n`);
  if (err.details) {
    process.stderr.write(`${err.details}\n`);
  }
}
