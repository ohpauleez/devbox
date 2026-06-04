/**
 * @module wait-policy
 *
 * Defines polling intervals, timeout bounds, and the injectable `Clock` interface
 * for all time-dependent domain operations.
 *
 * @remarks
 * All timing constants are in milliseconds. The `Clock` interface pushes
 * non-determinism (wall-clock time) to the edges, enabling deterministic
 * unit tests by injecting fake clocks.
 */

/**
 * Poll cadence for EC2 lifecycle waits.
 *
 * @remarks
 * Units: milliseconds. Used by `waitForEc2TargetState`.
 */
export const EC2_POLL_INTERVAL_MS = 5_000;

/**
 * Upper bound for EC2 lifecycle waits.
 *
 * @remarks
 * Units: milliseconds (5 minutes). If the target state is not reached
 * within this bound, a `TimeoutError` is returned.
 */
export const EC2_WAIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Poll cadence for SSM readiness checks.
 *
 * @remarks
 * Units: milliseconds. Used by `waitForSsmOnline`.
 */
export const SSM_POLL_INTERVAL_MS = 5_000;

/**
 * Upper bound for SSM readiness waits.
 *
 * @remarks
 * Units: milliseconds (2 minutes). If SSM does not report "Online"
 * within this bound, a `TimeoutError` is returned.
 */
export const SSM_WAIT_TIMEOUT_MS = 2 * 60_000;

/**
 * Stale lock age threshold for config-store recovery.
 *
 * @remarks
 * Units: milliseconds (5 minutes). Lock files older than this are
 * considered abandoned and eligible for forced removal.
 */
export const CONFIG_LOCK_STALE_AFTER_MS = 5 * 60_000;

/**
 * Clock interface for injecting time sources.
 *
 * @remarks
 * Pushes non-determinism (time) to the edges per the style guide.
 * All polling loops and timestamp generation accept an optional `Clock`
 * parameter, defaulting to `REAL_CLOCK` in production.
 *
 * Invariant: implementations must be monotonically non-decreasing for `nowMs()`.
 * Concurrency: implementations must be safe for concurrent access (no shared mutable state).
 */
export interface Clock {
  /**
   * Returns current time in milliseconds since Unix epoch.
   *
   * @returns integer milliseconds since 1970-01-01T00:00:00Z
   */
  nowMs(): number;
  /**
   * Returns current time as ISO-8601 UTC string.
   *
   * @returns string in the form `YYYY-MM-DDTHH:mm:ss.sssZ`
   */
  isoNow(): string;
}

/**
 * Default real-time clock implementation backed by `Date`.
 *
 * @remarks
 * Uses `Date.now()` and `new Date().toISOString()` directly.
 * Suitable for production; replace with a fake clock in tests.
 */
export const REAL_CLOCK: Clock = {
  nowMs: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};
