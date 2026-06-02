import fs from "node:fs/promises";
import { DevboxConfig } from "./config-schema.js";
import { DevboxError } from "./errors.js";
import { AwsTagSpecification, mergeInstanceTags } from "./tags.js";

const ALLOWLIST = new Set([
  "BlockDeviceMappings",
  "CapacityReservationSpecification",
  "CpuOptions",
  "CreditSpecification",
  "DisableApiStop",
  "DisableApiTermination",
  "EbsOptimized",
  "EnclaveOptions",
  "HibernationOptions",
  "IamInstanceProfile",
  "ImageId",
  "InstanceInitiatedShutdownBehavior",
  "InstanceMarketOptions",
  "InstanceType",
  "KernelId",
  "KeyName",
  "LicenseSpecifications",
  "MaintenanceOptions",
  "MetadataOptions",
  "Monitoring",
  "NetworkInterfaces",
  "Placement",
  "PrivateDnsNameOptions",
  "RamDiskId",
  "SecurityGroupIds",
  "SecurityGroups",
  "TagSpecifications",
  "UserData",
]);

export type InitPayload = Record<string, unknown>;

export async function loadTemplateFile(templatePath: string): Promise<InitPayload> {
  let raw: string;
  try {
    raw = await fs.readFile(templatePath, "utf8");
  } catch {
    throw new DevboxError("ValidationError", `Template file is not readable: ${templatePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DevboxError("ValidationError", `Template file is not valid JSON: ${templatePath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DevboxError("ValidationError", "Template root must be a JSON object");
  }
  return parsed as InitPayload;
}

export function mapInitPayload(
  alias: string,
  template: InitPayload,
  config: DevboxConfig,
): InitPayload {
  const keys = Object.keys(template);
  for (const key of keys) {
    if (key === "InstanceRequirements") {
      throw new DevboxError("ValidationError", "Field InstanceRequirements is not supported");
    }
    if (!ALLOWLIST.has(key)) {
      throw new DevboxError("ValidationError", `Unknown template field: ${key}`);
    }
  }

  const payload: InitPayload = { ...template };

  payload.ImageId = (payload.ImageId as string | undefined) ?? config.defaults.ImageId;
  payload.IamInstanceProfile =
    (payload.IamInstanceProfile as Record<string, unknown> | undefined) ??
    config.defaults.IamInstanceProfile;

  if (!payload.ImageId) {
    throw new DevboxError("ValidationError", "ImageId is required after merge");
  }
  if (!payload.IamInstanceProfile) {
    throw new DevboxError("ValidationError", "IamInstanceProfile is required after merge");
  }

  if (payload.NetworkInterfaces) {
    if (payload.SecurityGroupIds) {
      throw new DevboxError("ValidationError", "SecurityGroupIds is invalid when NetworkInterfaces is present");
    }
    if (payload.SecurityGroups) {
      throw new DevboxError("ValidationError", "SecurityGroups is invalid when NetworkInterfaces is present");
    }
  }

  const tagSpecs = (payload.TagSpecifications as AwsTagSpecification[] | undefined) ?? [];
  payload.TagSpecifications = mergeInstanceTags(alias, config.defaults.tags, tagSpecs);
  payload.MinCount = 1;
  payload.MaxCount = 1;

  return payload;
}
