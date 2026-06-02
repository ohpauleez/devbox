import { DevboxError } from "../domain/errors.js";
import { runProcess } from "./process.js";

export interface Ec2Description {
  instanceId: string;
  state: string;
  instanceType: string;
}

interface DescribeInstancesPayload {
  Reservations?: Array<{
    Instances?: Array<{
      InstanceId?: string;
      InstanceType?: string;
      State?: { Name?: string };
    }>;
  }>;
}

function sanitizeAwsStderr(stderr: string): string {
  return stderr.trim();
}

export async function awsJson<T>(args: string[], timeoutMs?: number): Promise<T> {
  const opts = timeoutMs ? { timeoutMs } : undefined;
  const result = await runProcess("aws", args, opts);
  if (result.code !== 0) {
    throw mapAwsError(result.stderr || `aws ${args.join(" ")} failed`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new DevboxError(
      "AwsCliError",
      "AWS CLI returned invalid JSON",
      sanitizeAwsStderr(result.stderr),
    );
  }
}

export async function awsPassthrough(args: string[], timeoutMs?: number): Promise<void> {
  const result = await runProcess("aws", args, {
    ...(timeoutMs ? { timeoutMs } : {}),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.code !== 0) {
    throw new DevboxError("AwsCliError", `AWS CLI command failed: aws ${args.join(" ")}`);
  }
}

export function mapAwsError(stderr: string): DevboxError {
  const normalized = sanitizeAwsStderr(stderr);
  if (normalized.includes("InvalidInstanceID.NotFound")) {
    return new DevboxError("NotFoundError", "Instance not found", normalized);
  }
  if (normalized.includes("UnauthorizedOperation") || normalized.includes("AuthFailure")) {
    return new DevboxError("AwsCliError", "AWS authorization failed", normalized);
  }
  if (normalized.includes("RequestLimitExceeded") || normalized.includes("Throttl")) {
    return new DevboxError("AwsCliError", "AWS API throttled request", normalized);
  }
  return new DevboxError("AwsCliError", "AWS CLI request failed", normalized);
}

export async function describeInstance(instanceId: string): Promise<Ec2Description> {
  const payload = await awsJson<DescribeInstancesPayload>([
    "ec2",
    "describe-instances",
    "--instance-ids",
    instanceId,
    "--output",
    "json",
  ]);

  const instance = payload.Reservations?.[0]?.Instances?.[0];
  if (!instance?.InstanceId || !instance?.State?.Name) {
    throw new DevboxError("NotFoundError", `Instance ${instanceId} not found`);
  }

  return {
    instanceId: instance.InstanceId,
    state: instance.State.Name,
    instanceType: instance.InstanceType ?? "unknown",
  };
}

export async function describeInstances(instanceIds: string[]): Promise<Map<string, Ec2Description>> {
  if (instanceIds.length === 0) {
    return new Map<string, Ec2Description>();
  }

  const payload = await awsJson<DescribeInstancesPayload>([
    "ec2",
    "describe-instances",
    "--instance-ids",
    ...instanceIds,
    "--output",
    "json",
  ]);

  const out = new Map<string, Ec2Description>();
  for (const reservation of payload.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      if (!instance.InstanceId || !instance.State?.Name) {
        continue;
      }
      out.set(instance.InstanceId, {
        instanceId: instance.InstanceId,
        state: instance.State.Name,
        instanceType: instance.InstanceType ?? "unknown",
      });
    }
  }
  return out;
}

export async function startInstance(instanceId: string): Promise<void> {
  await awsJson([
    "ec2",
    "start-instances",
    "--instance-ids",
    instanceId,
    "--output",
    "json",
  ]);
}

export async function stopInstance(instanceId: string): Promise<void> {
  await awsJson([
    "ec2",
    "stop-instances",
    "--instance-ids",
    instanceId,
    "--output",
    "json",
  ]);
}

export async function terminateInstance(instanceId: string): Promise<void> {
  try {
    await awsJson([
      "ec2",
      "terminate-instances",
      "--instance-ids",
      instanceId,
      "--output",
      "json",
    ]);
  } catch (err) {
    if (err instanceof DevboxError && err.code === "NotFoundError") {
      return;
    }
    throw err;
  }
}

export async function ssmReady(instanceId: string): Promise<boolean> {
  try {
    const payload = await awsJson<{
      InstanceInformationList?: Array<{ InstanceId?: string; PingStatus?: string }>;
    }>([
      "ssm",
      "describe-instance-information",
      "--filters",
      `Key=InstanceIds,Values=${instanceId}`,
      "--output",
      "json",
    ]);
    const row = payload.InstanceInformationList?.find((x) => x.InstanceId === instanceId);
    return row?.PingStatus === "Online";
  } catch (err) {
    if (err instanceof DevboxError && err.code === "AwsCliError") {
      return false;
    }
    throw err;
  }
}
