import { makeError, type DevboxError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import type { BoxAlias, BoxConfig, DevboxConfig } from "./types.js";

export interface CurrentBox {
  readonly alias: BoxAlias;
  readonly box: BoxConfig;
}

/**
 * Resolve the current box from config.
 *
 * @param config validated config state
 * @returns current alias and box when present
 */
export function resolveCurrentBox(config: DevboxConfig): Result<CurrentBox, DevboxError> {
  if (config.current === undefined) {
    return err(makeError("ValidationError", "no current box selected"));
  }
  const box = config.boxes[config.current];
  if (box === undefined) {
    return err(makeError("ConfigError", "current alias does not reference a tracked box"));
  }
  return ok({ alias: config.current, box });
}
