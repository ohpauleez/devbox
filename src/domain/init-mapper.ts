import { makeError, type DevboxError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { mergeRequiredTags, validateRequiredTags } from "./tags.js";
import type { DefaultsConfig, RequiredTags } from "./types.js";

const ALLOWED_TEMPLATE_KEYS = new Set([
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

export interface InitRunInstancesRequest {
  readonly payload: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toTagMap(tags: readonly unknown[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tag of tags) {
    if (!isRecord(tag)) {
      continue;
    }
    const key = tag.Key;
    const value = tag.Value;
    if (typeof key === "string" && typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function fromTagMap(map: Record<string, string>): readonly { readonly Key: string; readonly Value: string }[] {
  return Object.entries(map).map(([key, value]) => ({ Key: key, Value: value }));
}

function extractInstanceTags(tagSpecifications: unknown): readonly unknown[] {
  if (!Array.isArray(tagSpecifications)) {
    return [];
  }
  for (const spec of tagSpecifications) {
    if (!isRecord(spec)) {
      continue;
    }
    if (spec.ResourceType === "instance") {
      const tags = spec.Tags;
      if (Array.isArray(tags)) {
        return tags;
      }
    }
  }
  return [];
}

function preserveNonInstanceTagSpecs(tagSpecifications: unknown): readonly unknown[] {
  if (!Array.isArray(tagSpecifications)) {
    return [];
  }
  const result: unknown[] = [];
  for (const spec of tagSpecifications) {
    if (!isRecord(spec)) {
      continue;
    }
    if (spec.ResourceType !== "instance") {
      result.push(spec);
    }
  }
  return result;
}

function validateTemplateShape(template: Record<string, unknown>): Result<void, DevboxError> {
  for (const key of Object.keys(template)) {
    if (key === "InstanceRequirements") {
      return err(makeError("ValidationError", "template key InstanceRequirements is not supported"));
    }
    if (!ALLOWED_TEMPLATE_KEYS.has(key)) {
      return err(makeError("ValidationError", `unknown template top-level key: ${key}`));
    }
  }

  if (template.NetworkInterfaces !== undefined) {
    if (template.SecurityGroupIds !== undefined || template.SecurityGroups !== undefined) {
      return err(
        makeError(
          "ValidationError",
          "template with NetworkInterfaces must not use top-level SecurityGroupIds/SecurityGroups",
        ),
      );
    }
  }
  return ok(undefined);
}

function parseMergedRequiredTags(mergedMap: Record<string, string>): Result<RequiredTags, DevboxError> {
  const env = mergedMap.env;
  const service = mergedMap.service;
  const version = mergedMap.version;
  const customerData = mergedMap["customer-data"];
  const team = mergedMap.team;
  if (
    typeof env !== "string" ||
    typeof service !== "string" ||
    typeof version !== "string" ||
    typeof customerData !== "string" ||
    typeof team !== "string"
  ) {
    return err(makeError("ValidationError", "merged tags are missing required keys"));
  }

  const requiredTags: RequiredTags = {
    env,
    service,
    version,
    "customer-data": customerData,
    team,
  };
  const validation = validateRequiredTags(requiredTags);
  if (!validation.ok) {
    return err(makeError("ValidationError", validation.error.message));
  }
  return ok(requiredTags);
}

/**
 * Build `run-instances` payload from template + defaults + alias.
 */
export function mapInitTemplateToRunInstances(
  alias: string,
  template: unknown,
  defaults: DefaultsConfig,
): Result<InitRunInstancesRequest, DevboxError> {
  if (!isRecord(template)) {
    return err(makeError("ValidationError", "template must be a JSON object"));
  }

  const shapeValidation = validateTemplateShape(template);
  if (!shapeValidation.ok) {
    return shapeValidation;
  }

  const imageId = typeof template.ImageId === "string" ? template.ImageId : defaults.ImageId;
  const iamProfile = isRecord(template.IamInstanceProfile)
    ? template.IamInstanceProfile
    : defaults.IamInstanceProfile;

  if (typeof imageId !== "string" || imageId.trim().length === 0) {
    return err(makeError("ValidationError", "ImageId is required after merge"));
  }
  if (!isRecord(iamProfile)) {
    return err(makeError("ValidationError", "IamInstanceProfile is required after merge"));
  }

  const mergedDefaultsTags = mergeRequiredTags(defaults.tags);
  const templateInstanceTagMap = toTagMap(extractInstanceTags(template.TagSpecifications));
  const mergedTagMap: Record<string, string> = {
    ...mergedDefaultsTags,
    ...templateInstanceTagMap,
    Name: alias,
  };

  const requiredValidation = parseMergedRequiredTags(mergedTagMap);
  if (!requiredValidation.ok) {
    return requiredValidation;
  }

  const nonInstanceTagSpecs = preserveNonInstanceTagSpecs(template.TagSpecifications);
  const mergedTagSpecifications = [
    ...nonInstanceTagSpecs,
    {
      ResourceType: "instance",
      Tags: fromTagMap(mergedTagMap),
    },
  ];

  const payload: Record<string, unknown> = {
    ...template,
    ImageId: imageId,
    IamInstanceProfile: iamProfile,
    TagSpecifications: mergedTagSpecifications,
    MinCount: 1,
    MaxCount: 1,
  };

  return ok({ payload });
}
