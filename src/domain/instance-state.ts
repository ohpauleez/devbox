import { makeError, type DevboxError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export type Ec2InstanceState =
  | "pending"
  | "running"
  | "shutting-down"
  | "terminated"
  | "stopping"
  | "stopped"
  | "unknown";

export interface UpDecision {
  readonly targetState: "running";
  readonly submitStart: boolean;
  readonly wait: boolean;
}

export interface DownDecision {
  readonly targetState: "stopped";
  readonly submitStop: boolean;
  readonly wait: boolean;
}

/**
 * Decide transition policy for `up` given current state.
 */
export function decideUpAction(state: Ec2InstanceState): Result<UpDecision, DevboxError> {
  switch (state) {
    case "running":
      return ok({ targetState: "running", submitStart: false, wait: false });
    case "pending":
      return ok({ targetState: "running", submitStart: false, wait: true });
    case "stopped":
      return ok({ targetState: "running", submitStart: true, wait: true });
    case "shutting-down":
    case "terminated":
      return err(makeError("InstanceStateError", `cannot run up from instance state: ${state}`));
    case "stopping":
      return err(makeError("InstanceStateError", "cannot run up while instance is stopping"));
    case "unknown":
      return err(makeError("InstanceStateError", "cannot run up from unknown instance state"));
    default:
      return err(makeError("InstanceStateError", `unsupported instance state: ${state}`));
  }
}

/**
 * Decide transition policy for `down` given current state.
 */
export function decideDownAction(state: Ec2InstanceState): Result<DownDecision, DevboxError> {
  switch (state) {
    case "stopped":
      return ok({ targetState: "stopped", submitStop: false, wait: false });
    case "stopping":
      return ok({ targetState: "stopped", submitStop: false, wait: true });
    case "running":
      return ok({ targetState: "stopped", submitStop: true, wait: true });
    case "shutting-down":
    case "terminated":
      return err(makeError("InstanceStateError", `cannot run down from instance state: ${state}`));
    case "pending":
      return err(makeError("InstanceStateError", "cannot run down while instance is pending"));
    case "unknown":
      return err(makeError("InstanceStateError", "cannot run down from unknown instance state"));
    default:
      return err(makeError("InstanceStateError", `unsupported instance state: ${state}`));
  }
}
