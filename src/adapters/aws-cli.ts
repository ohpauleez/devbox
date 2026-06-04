/**
 * @module aws-cli
 *
 * AWS CLI adapter for EC2 and SSM operations.
 *
 * Shells out to the `aws` CLI binary for all AWS API interactions, parsing JSON responses
 * into typed domain objects. This avoids an SDK dependency and leverages the user's existing
 * AWS credential chain (environment variables, profiles, instance metadata).
 *
 * @remarks
 * All functions require the `aws` CLI to be installed and configured with valid credentials.
 * Responses are parsed defensively — malformed JSON or unexpected shapes produce `AwsCliError`.
 * Instance state values not recognized by this module are normalized to `"unknown"`.
 *
 * @example
 * ```ts
 * import { describeInstance, startInstance } from "./adapters/aws-cli.js";
 *
 * const desc = await describeInstance("i-0123456789abcdef0");
 * if (desc.ok && desc.value.state === "stopped") {
 *   await startInstance("i-0123456789abcdef0");
 * }
 * ```
 */

import type { Ec2InstanceState } from "../domain/instance-state.js";
import { makeError, type DevboxError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { runProcess } from "./process.js";

/**
 * Structured description of an EC2 instance's identity and current state.
 *
 * @remarks
 * The `state` field is normalized: unrecognized API values become `"unknown"`.
 */
export interface InstanceDescription {
  readonly instanceId: string;
  readonly state: Ec2InstanceState;
  readonly instanceType: string;
}

/**
 * Wrapper for the `run-instances` CLI input payload.
 *
 * @remarks
 * The `payload` is passed as `--cli-input-json` and must conform to the EC2 RunInstances schema.
 */
export interface RunInstancesRequest {
  readonly payload: Record<string, unknown>;
}

/** @internal */
interface AwsErrorInfo {
  readonly code?: string;
  readonly stderrLines: readonly string[];
}

/** Normalize raw state strings from the EC2 API to our domain union type. */
function mapEc2State(raw: unknown): Ec2InstanceState {
  switch (raw) {
    case "pending":
    case "running":
    case "shutting-down":
    case "terminated":
    case "stopping":
    case "stopped":
      return raw;
    default:
      return "unknown";
  }
}

/**
 * Inspect stderr output for known AWS error codes.
 *
 * AWS CLI emits structured error messages to stderr. We pattern-match against known error
 * codes to provide semantic error categories (e.g., NotFoundError) rather than generic failures.
 */
function detectAwsError(stderrLines: readonly string[]): AwsErrorInfo {
  const combined = stderrLines.join("\n");
  // InvalidInstanceID.NotFound is the canonical error when an instance-id doesn't exist
  // in the active account/region. We detect this to convert it into a NotFoundError.
  const invalidInstanceIdMatch = /InvalidInstanceID\.NotFound/.exec(combined);
  if (invalidInstanceIdMatch) {
    return { code: "InvalidInstanceID.NotFound", stderrLines };
  }
  return { stderrLines };
}

function parseJson<T>(raw: string, context: string): Result<T, DevboxError> {
  try {
    return ok(JSON.parse(raw) as T);
  } catch (error: unknown) {
    return err(makeError("AwsCliError", `${context} returned invalid JSON`, [`${error}`]));
  }
}

async function runAwsJson(args: readonly string[]): Promise<Result<unknown, DevboxError>> {
  const processResult = await runProcess("aws", args);
  if (!processResult.ok) {
    if (processResult.error.category === "DependencyError") {
      return processResult;
    }
    const details = processResult.error.details ?? [];
    const awsErrorInfo = detectAwsError(details);
    if (awsErrorInfo.code === "InvalidInstanceID.NotFound") {
      return err(makeError("NotFoundError", "instance not found in active AWS account/region", details));
    }
    return err(makeError("AwsCliError", "AWS CLI command failed", details));
  }

  return parseJson(processResult.value.stdout, "AWS CLI command");
}

/**
 * Flatten the nested Reservations→Instances structure from describe-instances.
 *
 * The EC2 describe-instances response groups instances by reservation (one reservation per
 * RunInstances call). For our purposes this grouping is irrelevant — we need a flat list.
 * Each level is validated defensively because the CLI output shape is not type-guaranteed.
 */
function flattenReservations(payload: unknown): readonly Record<string, unknown>[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const reservations = (payload as { Reservations?: unknown }).Reservations;
  if (!Array.isArray(reservations)) {
    return [];
  }

  const instances: Record<string, unknown>[] = [];
  for (const reservation of reservations) {
    if (typeof reservation !== "object" || reservation === null) {
      continue;
    }
    const innerInstances = (reservation as { Instances?: unknown }).Instances;
    if (!Array.isArray(innerInstances)) {
      continue;
    }
    for (const instance of innerInstances) {
      if (typeof instance === "object" && instance !== null) {
        instances.push(instance as Record<string, unknown>);
      }
    }
  }
  return instances;
}

function parseInstanceDescription(raw: Record<string, unknown>): Result<InstanceDescription, DevboxError> {
  const instanceId = raw.InstanceId;
  const instanceType = raw.InstanceType;
  const stateName =
    typeof raw.State === "object" && raw.State !== null
      ? (raw.State as { Name?: unknown }).Name
      : undefined;

  if (typeof instanceId !== "string") {
    return err(makeError("AwsCliError", "AWS describe-instances response missing InstanceId"));
  }
  if (typeof instanceType !== "string") {
    return err(makeError("AwsCliError", "AWS describe-instances response missing InstanceType"));
  }

  return ok({
    instanceId,
    instanceType,
    state: mapEc2State(stateName),
  });
}

/**
 * Describe one or more EC2 instances by id using `aws ec2 describe-instances`.
 *
 * @param instanceIds - List of EC2 instance identifiers (e.g., `["i-0123abc"]`).
 *   Must contain valid `i-` prefixed strings.
 * @returns On success (`ok`): a map from instance id to its description. The map may
 *   contain fewer entries than requested if AWS returns partial results.
 *   On error (`err`): `DependencyError` when AWS CLI is missing; `NotFoundError` when
 *   instance ids are invalid; `AwsCliError` on other AWS failures or malformed JSON.
 *
 * @remarks
 * Precondition: `instanceIds` contains valid EC2 instance id strings.
 * Postcondition: on success, the returned map contains an entry for each instance found by AWS.
 * Concurrency: safe to call concurrently; each call spawns an independent CLI process.
 * Bounds: a single API call is made regardless of the number of ids (subject to AWS limits).
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await describeInstances(["i-0123abc", "i-0456def"]);
 * if (result.ok) {
 *   for (const [id, desc] of result.value) {
 *     console.log(`${id}: ${desc.state}`);
 *   }
 * }
 * ```
 */
export async function describeInstances(
  instanceIds: readonly string[],
): Promise<Result<ReadonlyMap<string, InstanceDescription>, DevboxError>> {
  if (instanceIds.length === 0) {
    return ok(new Map());
  }

  const args = [
    "ec2",
    "describe-instances",
    "--instance-ids",
    ...instanceIds,
    "--output",
    "json",
  ];
  const jsonResult = await runAwsJson(args);
  if (!jsonResult.ok) {
    return jsonResult;
  }

  const rawInstances = flattenReservations(jsonResult.value);
  const resultMap = new Map<string, InstanceDescription>();
  for (const rawInstance of rawInstances) {
    const parsed = parseInstanceDescription(rawInstance);
    if (!parsed.ok) {
      return parsed;
    }
    resultMap.set(parsed.value.instanceId, parsed.value);
  }
  return ok(resultMap);
}

/**
 * Describe exactly one EC2 instance by id.
 *
 * @param instanceId - Single EC2 instance identifier (e.g., `"i-0123abc"`). Must be non-empty.
 * @returns On success (`ok`): the instance description matching the requested id.
 *   On error (`err`): `NotFoundError` when instance does not exist in the active account/region;
 *   `DependencyError` when AWS CLI is missing; `AwsCliError` on other AWS failures.
 *
 * @remarks
 * Precondition: `instanceId` is a non-empty string.
 * Postcondition: on success, the returned description matches the requested instance exactly.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await describeInstance("i-0123456789abcdef0");
 * if (result.ok) {
 *   console.log(`Instance type: ${result.value.instanceType}, state: ${result.value.state}`);
 * }
 * ```
 */
export async function describeInstance(instanceId: string): Promise<Result<InstanceDescription, DevboxError>> {
  const descriptionsResult = await describeInstances([instanceId]);
  if (!descriptionsResult.ok) {
    return descriptionsResult;
  }
  const found = descriptionsResult.value.get(instanceId);
  if (found === undefined) {
    return err(makeError("NotFoundError", `instance not found in active AWS account/region: ${instanceId}`));
  }
  return ok(found);
}

/**
 * Submit `aws ec2 start-instances` for one instance.
 *
 * @param instanceId - EC2 instance identifier to start (e.g., `"i-0123abc"`).
 * @returns On success (`ok`): `undefined` — the start request has been accepted by AWS.
 *   The instance may still be transitioning; poll state separately.
 *   On error (`err`): `DependencyError` when AWS CLI is missing; `NotFoundError` when
 *   instance does not exist; `AwsCliError` on other AWS failures.
 *
 * @remarks
 * Precondition: `instanceId` references a stopped or stopping instance.
 * Postcondition: on success, AWS has accepted the start request (instance may still be transitioning).
 * Ownership: does not wait for the instance to reach "running" state.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await startInstance("i-0123456789abcdef0");
 * if (!result.ok) {
 *   console.error(`Start failed: ${result.error.message}`);
 * }
 * ```
 */
export async function startInstance(instanceId: string): Promise<Result<void, DevboxError>> {
  const processResult = await runProcess("aws", [
    "ec2",
    "start-instances",
    "--instance-ids",
    instanceId,
    "--output",
    "json",
  ]);
  if (!processResult.ok) {
    if (processResult.error.category === "DependencyError") {
      return processResult;
    }
    const details = processResult.error.details ?? [];
    const awsErrorInfo = detectAwsError(details);
    if (awsErrorInfo.code === "InvalidInstanceID.NotFound") {
      return err(makeError("NotFoundError", `instance not found in active AWS account/region: ${instanceId}`, details));
    }
    return err(makeError("AwsCliError", `failed to start instance: ${instanceId}`, details));
  }
  return ok(undefined);
}

/**
 * Submit `aws ec2 stop-instances` for one instance.
 *
 * @param instanceId - EC2 instance identifier to stop (e.g., `"i-0123abc"`).
 * @returns On success (`ok`): `undefined` — the stop request has been accepted by AWS.
 *   The instance may still be transitioning; poll state separately.
 *   On error (`err`): `DependencyError` when AWS CLI is missing; `NotFoundError` when
 *   instance does not exist; `AwsCliError` on other AWS failures.
 *
 * @remarks
 * Precondition: `instanceId` references a running or pending instance.
 * Postcondition: on success, AWS has accepted the stop request (instance may still be transitioning).
 * Ownership: does not wait for the instance to reach "stopped" state.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await stopInstance("i-0123456789abcdef0");
 * if (!result.ok) {
 *   console.error(`Stop failed: ${result.error.message}`);
 * }
 * ```
 */
export async function stopInstance(instanceId: string): Promise<Result<void, DevboxError>> {
  const processResult = await runProcess("aws", [
    "ec2",
    "stop-instances",
    "--instance-ids",
    instanceId,
    "--output",
    "json",
  ]);
  if (!processResult.ok) {
    if (processResult.error.category === "DependencyError") {
      return processResult;
    }
    const details = processResult.error.details ?? [];
    const awsErrorInfo = detectAwsError(details);
    if (awsErrorInfo.code === "InvalidInstanceID.NotFound") {
      return err(makeError("NotFoundError", `instance not found in active AWS account/region: ${instanceId}`, details));
    }
    return err(makeError("AwsCliError", `failed to stop instance: ${instanceId}`, details));
  }
  return ok(undefined);
}

/**
 * Submit `aws ec2 terminate-instances` for one instance.
 *
 * @param instanceId - EC2 instance identifier to terminate (e.g., `"i-0123abc"`).
 * @returns On success (`ok`): `"terminated"` when the request was accepted, or
 *   `"already-absent"` when the instance was not found (idempotent semantics).
 *   On error (`err`): `DependencyError` when AWS CLI is missing; `AwsCliError` on other failures.
 *
 * @remarks
 * Precondition: `instanceId` is a non-empty string.
 * Postcondition: on success, the instance is either terminated or confirmed absent.
 * This function is idempotent: calling it on a non-existent instance returns `"already-absent"`
 * rather than failing.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await terminateInstance("i-0123456789abcdef0");
 * if (result.ok) {
 *   console.log(result.value === "terminated" ? "Destroyed" : "Was already gone");
 * }
 * ```
 */
export async function terminateInstance(instanceId: string): Promise<Result<"terminated" | "already-absent", DevboxError>> {
  const processResult = await runProcess("aws", [
    "ec2",
    "terminate-instances",
    "--instance-ids",
    instanceId,
    "--output",
    "json",
  ]);
  if (!processResult.ok) {
    if (processResult.error.category === "DependencyError") {
      return processResult;
    }
    const details = processResult.error.details ?? [];
    const awsErrorInfo = detectAwsError(details);
    if (awsErrorInfo.code === "InvalidInstanceID.NotFound") {
      return ok("already-absent");
    }
    return err(makeError("AwsCliError", `failed to terminate instance: ${instanceId}`, details));
  }
  return ok("terminated");
}

/**
 * Launch one EC2 instance using `aws ec2 run-instances` with JSON input.
 *
 * @param request - Run-instances payload wrapped in `RunInstancesRequest`. The `payload` field
 *   is serialized and passed as `--cli-input-json`.
 * @returns On success (`ok`): object containing the launched instance's id.
 *   On error (`err`): `DependencyError` when AWS CLI is missing; `AwsCliError` when launch
 *   fails or response does not contain exactly one instance with a valid id.
 *
 * @remarks
 * Precondition: `request.payload` is a valid EC2 RunInstances JSON structure.
 * Postcondition: on success, exactly one instance was created and its id is returned.
 * The instance will be in "pending" state; poll for "running" separately.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await runInstances({
 *   payload: { ImageId: "ami-abc123", InstanceType: "t3.micro", MinCount: 1, MaxCount: 1 },
 * });
 * if (result.ok) {
 *   console.log(`Launched: ${result.value.instanceId}`);
 * }
 * ```
 */
export async function runInstances(
  request: RunInstancesRequest,
): Promise<Result<{ readonly instanceId: string }, DevboxError>> {
  const processResult = await runProcess("aws", [
    "ec2",
    "run-instances",
    "--cli-input-json",
    JSON.stringify(request.payload),
    "--output",
    "json",
  ]);
  if (!processResult.ok) {
    if (processResult.error.category === "DependencyError") {
      return processResult;
    }
    return err(makeError("AwsCliError", "failed to launch instance", processResult.error.details ?? []));
  }

  const parsed = parseJson<{ Instances?: readonly { InstanceId?: unknown }[] }>(
    processResult.value.stdout,
    "run-instances",
  );
  if (!parsed.ok) {
    return parsed;
  }

  const instances = parsed.value.Instances;
  if (!Array.isArray(instances) || instances.length !== 1) {
    return err(makeError("AwsCliError", "run-instances did not return exactly one instance"));
  }
  const instanceId = instances[0]?.InstanceId;
  if (typeof instanceId !== "string") {
    return err(makeError("AwsCliError", "run-instances response missing instance id"));
  }

  return ok({ instanceId });
}

/**
 * Query SSM managed-instance ping status for one instance.
 *
 * @param instanceId - EC2 instance identifier to query (e.g., `"i-0123abc"`).
 * @returns On success (`ok`): `"Online"`, `"ConnectionLost"`, or `"Inactive"` reflecting
 *   current SSM agent connectivity, or `undefined` when the instance is not SSM-registered.
 *   On error (`err`): `DependencyError` when AWS CLI is missing; `AwsCliError` on other
 *   AWS/SSM failures.
 *
 * @remarks
 * Precondition: `instanceId` is a non-empty string referencing a potentially SSM-managed instance.
 * Postcondition: on success, the returned status reflects current SSM agent connectivity.
 * A return of `undefined` means the instance has never registered with SSM, not that it's offline.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await describeSsmPingStatus("i-0123456789abcdef0");
 * if (result.ok && result.value === "Online") {
 *   console.log("SSM agent is reachable");
 * }
 * ```
 */
export async function describeSsmPingStatus(
  instanceId: string,
): Promise<Result<"Online" | "ConnectionLost" | "Inactive" | undefined, DevboxError>> {
  const jsonResult = await runAwsJson([
    "ssm",
    "describe-instance-information",
    "--filters",
    `Key=InstanceIds,Values=${instanceId}`,
    "--output",
    "json",
  ]);
  if (!jsonResult.ok) {
    return jsonResult;
  }

  if (typeof jsonResult.value !== "object" || jsonResult.value === null) {
    return err(makeError("AwsCliError", "invalid SSM response shape"));
  }
  const list = (jsonResult.value as { InstanceInformationList?: unknown }).InstanceInformationList;
  if (!Array.isArray(list) || list.length === 0) {
    return ok(undefined);
  }
  const first = list[0];
  if (typeof first !== "object" || first === null) {
    return ok(undefined);
  }
  const status = (first as { PingStatus?: unknown }).PingStatus;
  if (status === "Online" || status === "ConnectionLost" || status === "Inactive") {
    return ok(status);
  }
  return ok(undefined);
}
