import { makeError, type DevboxError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export type SsmPingStatus = "Online" | "ConnectionLost" | "Inactive";

/**
 * Validate that SSM ping status indicates ready transport.
 */
export function ensureSsmReady(status: SsmPingStatus | undefined): Result<void, DevboxError> {
  if (status === "Online") {
    return ok(undefined);
  }
  return err(makeError("TimeoutError", "instance did not become SSM-ready within timeout"));
}
