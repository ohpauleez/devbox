import { assertNever } from "./assert.js";
import { makeTypedError, type InstanceStateError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

/**
 * EC2 instance lifecycle states as reported by the AWS API.
 *
 * @remarks
 * "unknown" is a synthetic state used when the API response cannot be mapped
 * to a recognized lifecycle state.
 */
export type Ec2InstanceState =
  | "pending"
  | "running"
  | "shutting-down"
  | "terminated"
  | "stopping"
  | "stopped"
  | "unknown";

/**
 * Decision result for the `up` command state machine.
 *
 * @remarks
 * Invariant: `targetState` is always "running".
 * `submitStart` indicates whether a StartInstances API call is needed.
 * `wait` indicates whether polling for the target state is needed.
 */
export interface UpDecision {
  readonly targetState: "running";
  readonly submitStart: boolean;
  readonly wait: boolean;
}

/**
 * Decision result for the `down` command state machine.
 *
 * @remarks
 * Invariant: `targetState` is always "stopped".
 * `submitStop` indicates whether a StopInstances API call is needed.
 * `wait` indicates whether polling for the target state is needed.
 */
export interface DownDecision {
  readonly targetState: "stopped";
  readonly submitStop: boolean;
  readonly wait: boolean;
}

/**
 * Decide transition policy for `up` given current state.
 *
 * @param state - current EC2 instance state
 * @returns decision describing whether to submit start and/or wait, or `InstanceStateError`
 *
 * @remarks
 * Precondition: `state` is a valid `Ec2InstanceState` value.
 * Postcondition on success: `decision.targetState === "running"`.
 * Failures: `InstanceStateError` when the instance is in a terminal or incompatible state
 * (shutting-down, terminated, stopping, unknown).
 * Invariant: pure function — no side effects.
 *
 * @example
 * ```ts
 * import { decideUpAction } from "./instance-state.js";
 *
 * const result = decideUpAction("stopped");
 * // result.ok === true
 * // result.value === { targetState: "running", submitStart: true, wait: true }
 *
 * const errResult = decideUpAction("terminated");
 * // errResult.ok === false
 * // errResult.error.category === "InstanceStateError"
 * ```
 */
export function decideUpAction(state: Ec2InstanceState): Result<UpDecision, InstanceStateError> {
  switch (state) {
    case "running":
      return ok({ targetState: "running", submitStart: false, wait: false });
    case "pending":
      return ok({ targetState: "running", submitStart: false, wait: true });
    case "stopped":
      return ok({ targetState: "running", submitStart: true, wait: true });
    case "shutting-down":
    case "terminated":
      return err(makeTypedError("InstanceStateError", `cannot run up from instance state: ${state}`));
    case "stopping":
      return err(makeTypedError("InstanceStateError", "cannot run up while instance is stopping"));
    case "unknown":
      return err(makeTypedError("InstanceStateError", "cannot run up from unknown instance state"));
    default:
      return assertNever(state);
  }
}

/**
 * Decide transition policy for `down` given current state.
 *
 * @param state - current EC2 instance state
 * @returns decision describing whether to submit stop and/or wait, or `InstanceStateError`
 *
 * @remarks
 * Precondition: `state` is a valid `Ec2InstanceState` value.
 * Postcondition on success: `decision.targetState === "stopped"`.
 * Failures: `InstanceStateError` when the instance is in a terminal or incompatible state
 * (shutting-down, terminated, pending, unknown).
 * Invariant: pure function — no side effects.
 *
 * @example
 * ```ts
 * import { decideDownAction } from "./instance-state.js";
 *
 * const result = decideDownAction("running");
 * // result.ok === true
 * // result.value === { targetState: "stopped", submitStop: true, wait: true }
 *
 * const errResult = decideDownAction("terminated");
 * // errResult.ok === false
 * // errResult.error.category === "InstanceStateError"
 * ```
 */
export function decideDownAction(state: Ec2InstanceState): Result<DownDecision, InstanceStateError> {
  switch (state) {
    case "stopped":
      return ok({ targetState: "stopped", submitStop: false, wait: false });
    case "stopping":
      return ok({ targetState: "stopped", submitStop: false, wait: true });
    case "running":
      return ok({ targetState: "stopped", submitStop: true, wait: true });
    case "shutting-down":
    case "terminated":
      return err(makeTypedError("InstanceStateError", `cannot run down from instance state: ${state}`));
    case "pending":
      return err(makeTypedError("InstanceStateError", "cannot run down while instance is pending"));
    case "unknown":
      return err(makeTypedError("InstanceStateError", "cannot run down from unknown instance state"));
    default:
      return assertNever(state);
  }
}
