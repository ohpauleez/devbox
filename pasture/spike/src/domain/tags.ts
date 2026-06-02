import { DevboxError } from "./errors.js";
import { BUILTIN_REQUIRED_TAG_DEFAULTS } from "./config-schema.js";

export interface AwsTag {
  Key: string;
  Value: string;
}

export interface AwsTagSpecification {
  ResourceType: string;
  Tags?: AwsTag[];
}

function toMap(tags: AwsTag[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of tags) {
    m.set(t.Key, t.Value);
  }
  return m;
}

function fromMap(map: Map<string, string>): AwsTag[] {
  return Array.from(map.entries()).map(([Key, Value]) => ({ Key, Value }));
}

export function mergeInstanceTags(
  alias: string,
  configTags: Record<string, string>,
  tagSpecs: AwsTagSpecification[] | undefined,
): AwsTagSpecification[] {
  const output: AwsTagSpecification[] = [];
  const instanceSpec = tagSpecs?.find((s) => s.ResourceType === "instance");
  const rest = (tagSpecs ?? []).filter((s) => s.ResourceType !== "instance");

  const merged = new Map<string, string>(
    Object.entries(BUILTIN_REQUIRED_TAG_DEFAULTS).map(([k, v]) => [k, v]),
  );
  for (const [k, v] of Object.entries(configTags)) {
    merged.set(k, v);
  }
  for (const [k, v] of toMap(instanceSpec?.Tags ?? [])) {
    if (k === "Name") {
      continue;
    }
    merged.set(k, v);
  }
  merged.set("Name", alias);

  enforceRequiredTags(merged);

  output.push(...rest);
  output.push({ ResourceType: "instance", Tags: fromMap(merged) });
  return output;
}

function enforceRequiredTags(tags: Map<string, string>): void {
  const required = ["env", "service", "version", "customer-data", "team"];
  for (const key of required) {
    const value = tags.get(key);
    if (!value || value.trim().length === 0) {
      throw new DevboxError("ValidationError", `Missing required tag '${key}'`);
    }
  }
  if (!["prod", "preprod", "staging", "dev"].includes(tags.get("env") ?? "")) {
    throw new DevboxError("ValidationError", "Tag 'env' must be prod|preprod|staging|dev");
  }
  if ((tags.get("service") ?? "") !== "devbox") {
    throw new DevboxError("ValidationError", "Tag 'service' must equal devbox");
  }
  const version = tags.get("version") ?? "";
  if (version.length < 7 || version.length > 40) {
    throw new DevboxError("ValidationError", "Tag 'version' must be 7..40 chars");
  }
  if (!["true", "false"].includes(tags.get("customer-data") ?? "")) {
    throw new DevboxError("ValidationError", "Tag 'customer-data' must be true|false");
  }
}
