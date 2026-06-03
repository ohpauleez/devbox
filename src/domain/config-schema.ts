import { parseAlias } from "./alias.js";
import { makeError, type DevboxError } from "./errors.js";
import { assertNever } from "./assert.js";
import { err, ok, type Result } from "./result.js";
import {
  BUILTIN_REQUIRED_TAG_DEFAULTS,
  validateRequiredTags,
} from "./tags.js";
import type {
  BoxAlias,
  BoxConfig,
  DefaultsConfig,
  DevboxConfig,
  InstanceId,
  RequiredTags,
  SshUser,
} from "./types.js";

const SSH_USER_PATTERN = /^[^\s\x00-\x1f\x7f]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSshUser(raw: unknown, fieldName: string): Result<SshUser, DevboxError> {
  if (typeof raw !== "string") {
    return err(makeError("ConfigError", `${fieldName} must be a string`));
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || !SSH_USER_PATTERN.test(trimmed)) {
    return err(makeError("ConfigError", `${fieldName} must be a non-empty safe token`));
  }
  return ok(trimmed as SshUser);
}

function parseLastConnectAt(raw: unknown): Result<string, DevboxError> {
  if (typeof raw !== "string") {
    return err(makeError("ConfigError", "lastConnectAt must be a string"));
  }
  const timestampMs = Date.parse(raw);
  if (!Number.isFinite(timestampMs)) {
    return err(makeError("ConfigError", "lastConnectAt must be an ISO-8601 timestamp"));
  }
  return ok(raw);
}

function parseInstanceId(raw: unknown): Result<InstanceId, DevboxError> {
  if (typeof raw !== "string") {
    return err(makeError("ConfigError", "instanceId must be a string"));
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return err(makeError("ConfigError", "instanceId must not be empty"));
  }
  return ok(trimmed as InstanceId);
}

function parseRequiredTags(raw: unknown): Result<RequiredTags, DevboxError> {
  if (!isRecord(raw)) {
    return err(makeError("ConfigError", "defaults.tags must be an object"));
  }
  const env = raw.env;
  const service = raw.service;
  const version = raw.version;
  const customerData = raw["customer-data"];
  const team = raw.team;
  if (
    typeof env !== "string" ||
    typeof service !== "string" ||
    typeof version !== "string" ||
    typeof customerData !== "string" ||
    typeof team !== "string"
  ) {
    return err(
      makeError(
        "ConfigError",
        "defaults.tags must include string values for env, service, version, customer-data, and team",
      ),
    );
  }

  const tags: RequiredTags = {
    env,
    service,
    version,
    "customer-data": customerData,
    team,
  };
  const tagsValidation = validateRequiredTags(tags);
  if (!tagsValidation.ok) {
    return err(tagsValidation.error);
  }
  return ok(tags);
}

function parseDefaults(raw: unknown): Result<DefaultsConfig, DevboxError> {
  if (!isRecord(raw)) {
    return err(makeError("ConfigError", "defaults must be an object"));
  }

  const parsedTags = parseRequiredTags(raw.tags);
  if (!parsedTags.ok) {
    return parsedTags;
  }

  let sshUser: SshUser | undefined;
  if (raw.sshUser !== undefined) {
    const parsedSshUser = parseSshUser(raw.sshUser, "defaults.sshUser");
    if (!parsedSshUser.ok) {
      return parsedSshUser;
    }
    sshUser = parsedSshUser.value;
  }

  let imageId: string | undefined;
  if (raw.ImageId !== undefined) {
    if (typeof raw.ImageId !== "string" || raw.ImageId.trim().length === 0) {
      return err(makeError("ConfigError", "defaults.ImageId must be a non-empty string"));
    }
    imageId = raw.ImageId;
  }

  let iamProfile: DefaultsConfig["IamInstanceProfile"];
  if (raw.IamInstanceProfile !== undefined) {
    if (!isRecord(raw.IamInstanceProfile)) {
      return err(makeError("ConfigError", "defaults.IamInstanceProfile must be an object"));
    }
    const arn = raw.IamInstanceProfile.Arn;
    const name = raw.IamInstanceProfile.Name;
    if (arn !== undefined && (typeof arn !== "string" || arn.trim().length === 0)) {
      return err(makeError("ConfigError", "defaults.IamInstanceProfile.Arn must be a non-empty string"));
    }
    if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
      return err(makeError("ConfigError", "defaults.IamInstanceProfile.Name must be a non-empty string"));
    }
    if (arn === undefined && name === undefined) {
      return err(makeError("ConfigError", "defaults.IamInstanceProfile requires Arn or Name"));
    }
    const profile: { Arn?: string; Name?: string } = {};
    if (arn !== undefined) {
      profile.Arn = arn;
    }
    if (name !== undefined) {
      profile.Name = name;
    }
    iamProfile = profile;
  }

  const defaults: DefaultsConfig = {
    tags: parsedTags.value,
    ...(imageId !== undefined ? { ImageId: imageId } : {}),
    ...(iamProfile !== undefined ? { IamInstanceProfile: iamProfile } : {}),
    ...(sshUser !== undefined ? { sshUser } : {}),
  };
  return ok(defaults);
}

function parseBoxConfig(raw: unknown): Result<BoxConfig, DevboxError> {
  if (!isRecord(raw)) {
    return err(makeError("ConfigError", "box configuration must be an object"));
  }

  const parsedInstanceId = parseInstanceId(raw.instanceId);
  if (!parsedInstanceId.ok) {
    return parsedInstanceId;
  }

  let lastConnectAt: string | undefined;
  if (raw.lastConnectAt !== undefined) {
    const parsedTimestamp = parseLastConnectAt(raw.lastConnectAt);
    if (!parsedTimestamp.ok) {
      return parsedTimestamp;
    }
    lastConnectAt = parsedTimestamp.value;
  }

  let sshUser: SshUser | undefined;
  if (raw.sshUser !== undefined) {
    const parsedSshUser = parseSshUser(raw.sshUser, "boxes.<alias>.sshUser");
    if (!parsedSshUser.ok) {
      return parsedSshUser;
    }
    sshUser = parsedSshUser.value;
  }

  const boxConfig: BoxConfig = {
    instanceId: parsedInstanceId.value,
    ...(lastConnectAt !== undefined ? { lastConnectAt } : {}),
    ...(sshUser !== undefined ? { sshUser } : {}),
  };
  return ok(boxConfig);
}

/**
 * Parse unknown config input into a validated config model.
 *
 * @param raw unknown decoded JSON value
 * @returns schema-valid config or ConfigError
 */
export function parseConfig(raw: unknown): Result<DevboxConfig, DevboxError> {
  if (!isRecord(raw)) {
    return err(makeError("ConfigError", "config must be a JSON object"));
  }
  if (!isRecord(raw.boxes)) {
    return err(makeError("ConfigError", "config.boxes must be an object"));
  }

  const boxes: Record<BoxAlias, BoxConfig> = {};
  const aliases = Object.keys(raw.boxes);
  for (const aliasValue of aliases) {
    const parsedAlias = parseAlias(aliasValue);
    if (!parsedAlias.ok) {
      return err(makeError("ConfigError", `invalid alias key in boxes: ${aliasValue}`));
    }
    const value = raw.boxes[aliasValue];
    const parsedBox = parseBoxConfig(value);
    if (!parsedBox.ok) {
      return parsedBox;
    }
    boxes[parsedAlias.value] = parsedBox.value;
  }

  const parsedDefaults = parseDefaults(raw.defaults);
  if (!parsedDefaults.ok) {
    return parsedDefaults;
  }

  let current: BoxAlias | undefined;
  if (raw.current !== undefined) {
    if (typeof raw.current !== "string") {
      return err(makeError("ConfigError", "config.current must be a string when present"));
    }
    const parsedCurrent = parseAlias(raw.current);
    if (!parsedCurrent.ok) {
      return err(makeError("ConfigError", "config.current is not a valid alias"));
    }
    if (!(parsedCurrent.value in boxes)) {
      return err(makeError("ConfigError", "config.current must reference a tracked alias"));
    }
    current = parsedCurrent.value;
  }

  const config: DevboxConfig = {
    boxes,
    defaults: parsedDefaults.value,
    ...(current !== undefined ? { current } : {}),
  };
  return ok(config);
}

/**
 * Build first-run config state for missing config files.
 *
 * @returns schema-valid synthesized config with empty tracking
 */
export function synthesizeFirstRunConfig(): DevboxConfig {
  return {
    boxes: {},
    defaults: {
      tags: BUILTIN_REQUIRED_TAG_DEFAULTS,
    },
  };
}

/**
 * Serialize config state using stable pretty formatting.
 *
 * @param config validated config
 * @returns newline-terminated JSON string
 */
export function serializeConfig(config: DevboxConfig): string {
  const doc: Record<string, unknown> = {
    boxes: config.boxes,
    defaults: config.defaults,
  };
  switch (config.current === undefined) {
    case true:
      break;
    case false:
      doc.current = config.current;
      break;
    default:
      assertNever(config.current as never);
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}
