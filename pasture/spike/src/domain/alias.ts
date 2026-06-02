import { DevboxError } from "./errors.js";

export const ALIAS_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function validateAlias(alias: string): void {
  if (!ALIAS_REGEX.test(alias)) {
    throw new DevboxError(
      "ValidationError",
      `Alias '${alias}' is invalid (must match ${ALIAS_REGEX.source})`,
    );
  }
}

export const INSTANCE_ID_REGEX = /^i-[0-9a-f]{8,17}$/;

export function warnIfInstanceIdOdd(instanceId: string): void {
  if (!INSTANCE_ID_REGEX.test(instanceId)) {
    process.stderr.write(
      `ValidationError: Instance ID '${instanceId}' does not match expected format; continuing\n`,
    );
  }
}
