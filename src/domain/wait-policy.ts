/**
 * Poll cadence for EC2 lifecycle waits.
 */
export const EC2_POLL_INTERVAL_MS = 5_000;

/**
 * Upper bound for EC2 lifecycle waits.
 */
export const EC2_WAIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Poll cadence for SSM readiness checks.
 */
export const SSM_POLL_INTERVAL_MS = 5_000;

/**
 * Upper bound for SSM readiness waits.
 */
export const SSM_WAIT_TIMEOUT_MS = 2 * 60_000;

/**
 * Upper bound for remote temporary key lifetime.
 */
export const REMOTE_TEMP_KEY_TTL_MS = 5 * 60_000;

/**
 * Stale lock age threshold for config-store recovery.
 */
export const CONFIG_LOCK_STALE_AFTER_MS = 5 * 60_000;
