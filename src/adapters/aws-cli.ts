import type { Ec2InstanceState } from "../domain/instance-state.js";
import { makeError, type DevboxError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { runProcess } from "./process.js";

export interface InstanceDescription {
  readonly instanceId: string;
  readonly state: Ec2InstanceState;
  readonly instanceType: string;
}

export interface RunInstancesRequest {
  readonly payload: Record<string, unknown>;
}

interface AwsErrorInfo {
  readonly code?: string;
  readonly stderrLines: readonly string[];
}

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

function splitLines(raw: string): readonly string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }
  return trimmed.split("\n");
}

function detectAwsError(stderrLines: readonly string[]): AwsErrorInfo {
  const combined = stderrLines.join("\n");
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
 * Describe one or more EC2 instances by id.
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
 * Describe exactly one instance id.
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
 * Submit `start-instances` for one instance.
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
 * Submit `stop-instances` for one instance.
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
 * Submit `terminate-instances` for one instance.
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
 * Launch one instance using `run-instances` JSON input.
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
