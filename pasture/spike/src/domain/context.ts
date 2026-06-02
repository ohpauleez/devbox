import { DevboxConfig } from "./config-schema.js";
import { DevboxError } from "./errors.js";

export function requireCurrent(config: DevboxConfig): { alias: string; instanceId: string } {
  const alias = config.current;
  if (!alias) {
    throw new DevboxError("ValidationError", "No current alias is set");
  }
  const box = config.boxes[alias];
  if (!box) {
    throw new DevboxError("ConfigError", "current references a missing alias");
  }
  return { alias, instanceId: box.instanceId };
}

export function requireAlias(config: DevboxConfig, alias: string): { instanceId: string } {
  const box = config.boxes[alias];
  if (!box) {
    throw new DevboxError("NotFoundError", `Alias not found: ${alias}`);
  }
  return { instanceId: box.instanceId };
}
