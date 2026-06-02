import { DevboxError } from "./errors.js";

export type Ec2State =
  | "pending"
  | "running"
  | "shutting-down"
  | "terminated"
  | "stopping"
  | "stopped"
  | "unknown";

export function assertUpPreState(state: string, instanceId: string): void {
  if (state === "shutting-down" || state === "terminated") {
    throw new DevboxError(
      "InstanceStateError",
      `Cannot start ${instanceId} from ${state}`,
    );
  }
}

export function assertDownPreState(state: string, instanceId: string): void {
  if (state === "shutting-down" || state === "terminated") {
    throw new DevboxError(
      "InstanceStateError",
      `Cannot stop ${instanceId} from ${state}`,
    );
  }
}
