/**
 * @module init-mapper
 *
 * Maps a user-provided launch template (JSON) plus config defaults into a
 * validated `run-instances` API payload for the `init` command.
 *
 * @remarks
 * The merge algorithm applies a layered precedence model:
 * 1. Template values override config defaults for `ImageId` and `IamInstanceProfile`.
 * 2. Required tags are merged: built-in defaults < config defaults < template tags.
 * 3. The `Name` tag is always set to the alias, overriding any template value.
 * 4. Non-instance TagSpecifications (e.g., volume tags) are preserved verbatim.
 */

import { makeTypedError, type ValidationError } from "./errors.js";
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

/**
 * Output of the init template mapping: a validated run-instances payload.
 *
 * @remarks
 * `payload` contains all keys required by the EC2 RunInstances API,
 * including merged tags, image ID, IAM profile, and MinCount/MaxCount = 1.
 */
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

function validateTemplateShape(template: Record<string, unknown>): Result<void, ValidationError> {
  for (const key of Object.keys(template)) {
    if (key === "InstanceRequirements") {
      return err(makeTypedError("ValidationError", "template key InstanceRequirements is not supported"));
    }
    if (!ALLOWED_TEMPLATE_KEYS.has(key)) {
      return err(makeTypedError("ValidationError", `unknown template top-level key: ${key}`));
    }
  }

  if (template.NetworkInterfaces !== undefined) {
    if (template.SecurityGroupIds !== undefined || template.SecurityGroups !== undefined) {
      return err(
        makeTypedError(
          "ValidationError",
          "template with NetworkInterfaces must not use top-level SecurityGroupIds/SecurityGroups",
        ),
      );
    }
  }
  return ok(undefined);
}

function parseMergedRequiredTags(mergedMap: Record<string, string>): Result<RequiredTags, ValidationError> {
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
    return err(makeTypedError("ValidationError", "merged tags are missing required keys"));
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
    return err(makeTypedError("ValidationError", validation.error.message));
  }
  return ok(requiredTags);
}

/**
 * Build `run-instances` payload from template + defaults + alias.
 *
 * @param alias - box alias used as the instance `Name` tag
 * @param template - unknown JSON template value (typically from a `.json` file)
 * @param defaults - config defaults providing fallback `ImageId`, `IamInstanceProfile`, and tags
 * @returns validated `InitRunInstancesRequest` on success; `ValidationError` on constraint violation
 *
 * @remarks
 * Precondition: `alias` is a non-empty string. `defaults` is a schema-valid `DefaultsConfig`.
 * Postcondition on success: payload contains `ImageId`, `IamInstanceProfile`, merged
 * `TagSpecifications` (with `Name` = alias), and `MinCount`/`MaxCount` = 1.
 *
 * Merge algorithm (literate):
 * 1. Validate template shape — reject unknown keys and unsupported combinations.
 * 2. Resolve `ImageId`: template value wins, else fall back to defaults.
 * 3. Resolve `IamInstanceProfile`: template value wins, else fall back to defaults.
 * 4. Merge tags: start with built-in defaults, overlay config defaults, overlay template
 *    instance tags, then force `Name` = alias. This ensures required tags are always present.
 * 5. Validate merged required tags against organizational constraints.
 * 6. Reassemble TagSpecifications preserving non-instance specs from the template.
 * 7. Construct final payload with all resolved values.
 *
 * Failures: `ValidationError` for invalid template structure, missing required fields after
 * merge, conflicting NetworkInterfaces + SecurityGroups, or tag constraint violations.
 *
 * @example
 * ```ts
 * import { mapInitTemplateToRunInstances } from "./init-mapper.js";
 *
 * const result = mapInitTemplateToRunInstances("dev1", templateJson, config.defaults);
 * if (result.ok) {
 *   // result.value.payload is ready for the RunInstances API
 * }
 * ```
 */
export function mapInitTemplateToRunInstances(
  alias: string,
  template: unknown,
  defaults: DefaultsConfig,
): Result<InitRunInstancesRequest, ValidationError> {
  if (!isRecord(template)) {
    return err(makeTypedError("ValidationError", "template must be a JSON object"));
  }

  // Step 1: Validate template shape — reject unknown or conflicting keys early.
  const shapeValidation = validateTemplateShape(template);
  if (!shapeValidation.ok) {
    return shapeValidation;
  }

  // Step 2: Resolve ImageId — template takes precedence over defaults.
  const imageId = typeof template.ImageId === "string" ? template.ImageId : defaults.ImageId;
  // Step 3: Resolve IamInstanceProfile — template takes precedence over defaults.
  const iamProfile = isRecord(template.IamInstanceProfile)
    ? template.IamInstanceProfile
    : defaults.IamInstanceProfile;

  if (typeof imageId !== "string" || imageId.trim().length === 0) {
    return err(makeTypedError("ValidationError", "ImageId is required after merge"));
  }
  if (!isRecord(iamProfile)) {
    return err(makeTypedError("ValidationError", "IamInstanceProfile is required after merge"));
  }

  // Step 4: Merge tags with layered precedence.
  // Start with built-in defaults overlaid by config defaults.
  const mergedDefaultsTags = mergeRequiredTags(defaults.tags);
  // Extract any existing instance tags from the template.
  const templateInstanceTagMap = toTagMap(extractInstanceTags(template.TagSpecifications));
  // Merge all layers; Name is always forced to the alias.
  const mergedTagMap: Record<string, string> = {
    ...mergedDefaultsTags,
    ...templateInstanceTagMap,
    Name: alias,
  };

  // Step 5: Validate that merged required tags satisfy organizational constraints.
  const requiredValidation = parseMergedRequiredTags(mergedTagMap);
  if (!requiredValidation.ok) {
    return requiredValidation;
  }

  // Step 6: Reassemble TagSpecifications preserving non-instance specs.
  const nonInstanceTagSpecs = preserveNonInstanceTagSpecs(template.TagSpecifications);
  const mergedTagSpecifications = [
    ...nonInstanceTagSpecs,
    {
      ResourceType: "instance",
      Tags: fromTagMap(mergedTagMap),
    },
  ];

  // Step 7: Construct final payload with all resolved values.
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
