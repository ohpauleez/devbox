import { makeTypedError, type RegistryResolutionError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import type { BoxAlias, BoxConfig, DevboxConfig } from "./types.js";

/**
 * Resolved current box containing the alias and its configuration.
 *
 * @remarks
 * Invariant: `alias` is always a key in the config's `boxes` map,
 * and `box` is the corresponding value.
 */
export interface CurrentBox {
  readonly alias: BoxAlias;
  readonly box: BoxConfig;
}

/**
 * Resolve the current box from config.
 *
 * @param config - validated config state from `parseConfig` or `loadConfig`
 * @returns `CurrentBox` containing the alias and its box config on success
 *
 * @remarks
 * Precondition: `config` has been schema-validated.
 * Postcondition: on success, `result.alias` is a key in `config.boxes` and `result.box` is its value.
 * Failures: `ValidationError` when no current box is selected; `ConfigError` when current alias
 * references a missing box (indicates config corruption).
 * Invariant: does not mutate `config`.
 *
 * @example
 * ```ts
 * import { resolveCurrentBox } from "./context.js";
 * import type { DevboxConfig } from "./types.js";
 *
 * const config: DevboxConfig = { boxes: { dev1: { instanceId: "i-abc" } }, current: "dev1", defaults: { ... } };
 * const result = resolveCurrentBox(config);
 * // result.ok === true
 * // result.value.alias === "dev1"
 * // result.value.box.instanceId === "i-abc"
 *
 * const noCurrentConfig: DevboxConfig = { boxes: {}, defaults: { ... } };
 * const err = resolveCurrentBox(noCurrentConfig);
 * // err.ok === false, err.error.category === "ValidationError"
 * ```
 */
export function resolveCurrentBox(config: DevboxConfig): Result<CurrentBox, RegistryResolutionError> {
  if (config.current === undefined) {
    return err(makeTypedError("ValidationError", "no current box selected"));
  }
  const box = config.boxes[config.current];
  if (box === undefined) {
    return err(makeTypedError("ConfigError", "current alias does not reference a tracked box"));
  }
  return ok({ alias: config.current, box });
}
