/**
 * @module config-store
 *
 * Single-writer atomic config persistence with advisory file locking.
 *
 * This module provides load/commit operations for the devbox configuration file using
 * a durability model that prevents partial writes from corrupting state:
 * write → fsync → atomic rename → directory fsync. An advisory PID-based lock file
 * serializes concurrent mutations from the same or different CLI invocations.
 *
 * @remarks
 * The locking strategy is advisory and best-effort, suitable for a single-user CLI tool.
 * It protects against accidental concurrent writes but is not a distributed lock.
 * Config file permissions are set to 0o600 (owner read/write only) because the file
 * may contain sensitive instance metadata.
 *
 * @example
 * ```ts
 * import { loadConfig, commitConfig } from "./adapters/config-store.js";
 *
 * const config = await loadConfig();
 * if (config.ok) {
 *   const updated = { ...config.value, lastUsed: Date.now() };
 *   await commitConfig(updated);
 * }
 * ```
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  parseConfig,
  serializeConfig,
  synthesizeFirstRunConfig,
} from "../domain/config-schema.js";
import { makeError, type DevboxError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { CONFIG_LOCK_STALE_AFTER_MS } from "../domain/wait-policy.js";
import type { DevboxConfig } from "../domain/types.js";

const CONFIG_FILE_MODE = 0o600;
const LOCK_FILE_MODE = 0o644;

/**
 * File path settings for the config store layer.
 *
 * @remarks
 * All three paths must reference the same directory for the atomic rename to be
 * guaranteed same-filesystem (rename(2) requires source and target on the same mount).
 */
export interface ConfigStorePaths {
  readonly directory: string;
  readonly configFile: string;
  readonly lockFile: string;
}

/**
 * Compute default config store paths using `$DEVBOX_CONFIG_DIR` or `~/.config`.
 *
 * @returns Config directory, config file, and lock file paths derived from environment
 *   or the user's home directory.
 *
 * @remarks
 * Precondition: `homedir()` returns a valid path (always true on supported platforms).
 * Postcondition: returned paths are absolute and reference the same directory.
 * The `DEVBOX_CONFIG_DIR` environment variable overrides the default `~/.config` base.
 *
 * @example
 * ```ts
 * const paths = defaultConfigStorePaths();
 * // paths.configFile === "/home/user/.config/devbox.json"
 * ```
 */
export function defaultConfigStorePaths(): ConfigStorePaths {
  const directory = process.env.DEVBOX_CONFIG_DIR ?? join(homedir(), ".config");
  return {
    directory,
    configFile: join(directory, "devbox.json"),
    lockFile: join(directory, "devbox.json.lock"),
  };
}

async function ensureDirectory(paths: ConfigStorePaths): Promise<Result<void, DevboxError>> {
  try {
    await mkdir(paths.directory, { recursive: true, mode: CONFIG_FILE_MODE });
    return ok(undefined);
  } catch (error: unknown) {
    return err(makeError("ConfigError", "failed to create config directory", [`${error}`]));
  }
}

function parsePid(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 tests process existence without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      return false;
    }
    const nodeError = error as NodeJS.ErrnoException;
    // EPERM means the process exists but we lack permission to signal it — still alive.
    if (nodeError.code === "EPERM") {
      return true;
    }
    return false;
  }
}

/**
 * Determine whether an existing lock file is stale.
 *
 * A lock is considered stale if any of these conditions hold:
 * 1. The lock file's mtime exceeds CONFIG_LOCK_STALE_AFTER_MS (timeout-based staleness).
 * 2. The PID stored in the lock file is not parseable (corrupted lock).
 * 3. The PID references a process that no longer exists (crash-based staleness).
 *
 * Returns `ok(false)` if the lock file doesn't exist (ENOENT), meaning there's nothing stale.
 */
async function isLockStale(paths: ConfigStorePaths): Promise<Result<boolean, DevboxError>> {
  try {
    const [raw, lockStat] = await Promise.all([
      readFile(paths.lockFile, "utf8"),
      stat(paths.lockFile),
    ]);
    // Age-based staleness: if the lock is older than the threshold, assume the holder crashed
    // without cleanup. This handles cases where PID was recycled by the OS.
    const lockAgeMs = Date.now() - lockStat.mtimeMs;
    if (lockAgeMs > CONFIG_LOCK_STALE_AFTER_MS) {
      return ok(true);
    }
    // Content-based staleness: if the PID is not parseable, the lock file is corrupt.
    const parsedPid = parsePid(raw);
    if (parsedPid === undefined) {
      return ok(true);
    }
    // Process-based staleness: if the owning process no longer exists, the lock is orphaned.
    return ok(!isProcessAlive(parsedPid));
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return ok(false);
    }
    return err(makeError("ConfigError", "failed to inspect config lock", [`${error}`]));
  }
}

async function removeLock(paths: ConfigStorePaths): Promise<void> {
  try {
    await unlink(paths.lockFile);
  } catch {
    // Best effort unlock in finally blocks.
  }
}

/**
 * Acquire an advisory lock for config mutation.
 *
 * Uses exclusive file creation (`wx` flag) for atomic lock acquisition.
 * If the lock already exists, checks staleness (dead PID or age > threshold)
 * and attempts one recovery cycle.
 *
 * @remarks
 * ## TOCTOU window analysis
 *
 * There is a small race window between stale-lock detection and recovery:
 * 1. Process A detects the lock is stale (holder PID is dead).
 * 2. Process B also detects the same stale lock concurrently.
 * 3. Process A unlinks the stale lock.
 * 4. Process B unlinks — this is a no-op if A already removed it (ENOENT is tolerated).
 * 5. Both attempt `wx` creation. Only one succeeds; the other gets EEXIST and fails.
 *
 * The losing process receives a ConfigError. This is acceptable for a single-user CLI:
 * genuine concurrent config mutations are rare and retrying is safe.
 *
 * ## Stale detection algorithm
 *
 * The lock file contains the holder's PID as a decimal string. Staleness is determined by:
 * - Age exceeding CONFIG_LOCK_STALE_AFTER_MS (protects against PID recycling).
 * - PID not parseable (corrupt lock file).
 * - PID references a dead process (normal crash recovery).
 */
async function acquireLock(paths: ConfigStorePaths): Promise<Result<void, DevboxError>> {
  const lockBody = `${process.pid}\n`;

  // Step 1: Attempt optimistic lock creation with O_CREAT|O_EXCL semantics.
  // This is atomic at the filesystem level — only one process can succeed.
  try {
    await writeFile(paths.lockFile, lockBody, {
      mode: LOCK_FILE_MODE,
      flag: "wx",
      encoding: "utf8",
    });
    return ok(undefined);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    // Any error other than "file already exists" is an unexpected filesystem failure.
    if (nodeError.code !== "EEXIST") {
      return err(makeError("ConfigError", "failed to create config lock", [`${error}`]));
    }

    // Step 2: Lock exists. Determine if the current holder is still alive.
    const staleResult = await isLockStale(paths);
    if (!staleResult.ok) {
      return staleResult;
    }
    if (!staleResult.value) {
      // Lock is held by a live process — we must not proceed.
      return err(makeError("ConfigError", "config lock is held by another active process"));
    }

    // Step 3: Lock is stale. Remove it and retry once.
    // ENOENT on unlink is tolerated because another process may have cleaned it first.
    try {
      await unlink(paths.lockFile);
    } catch (unlinkError: unknown) {
      const unlinkNodeError = unlinkError as NodeJS.ErrnoException;
      if (unlinkNodeError.code !== "ENOENT") {
        return err(makeError("ConfigError", "failed to remove stale config lock", [`${unlinkError}`]));
      }
    }

    // Step 4: Retry lock creation. If this fails, another process won the race.
    try {
      await writeFile(paths.lockFile, lockBody, {
        mode: LOCK_FILE_MODE,
        flag: "wx",
        encoding: "utf8",
      });
      return ok(undefined);
    } catch (retryError: unknown) {
      return err(makeError("ConfigError", "failed to acquire config lock after stale-lock recovery", [`${retryError}`]));
    }
  }
}

async function fsyncPath(filePath: string): Promise<Result<void, DevboxError>> {
  try {
    const handle = await open(filePath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return ok(undefined);
  } catch (error: unknown) {
    return err(makeError("ConfigError", `failed to fsync path: ${filePath}`, [`${error}`]));
  }
}

function parseConfigJson(raw: string): Result<DevboxConfig, DevboxError> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseConfig(parsed);
  } catch (error: unknown) {
    return err(makeError("ConfigError", "config file is not valid JSON", [`${error}`]));
  }
}

/**
 * Load config for local read-only commands.
 *
 * Reads directly and handles `ENOENT` from `readFile` to avoid a TOCTOU race:
 * checking existence first and then reading would allow deletion/replacement between
 * syscalls. A single read keeps the missing-file behavior and first-run fallback
 * while preserving atomicity assumptions around config replacement.
 *
 * @param paths - Optional path override for tests; defaults to `defaultConfigStorePaths()`.
 * @returns On success (`ok`): a parsed `DevboxConfig` satisfying all schema invariants.
 *   When the config file is missing (ENOENT), a first-run synthesized config is returned.
 *   On error (`err`): `ConfigError` when the file exists but contains invalid JSON,
 *   fails schema validation, or cannot be read for reasons other than ENOENT.
 *
 * @remarks
 * Precondition: the process has read access to the config directory.
 * Postcondition: on success, the returned config satisfies all `parseConfig` invariants.
 * Concurrency: safe to call concurrently with `commitConfig` — atomic rename guarantees
 * readers see either the old or new config, never a partial write.
 * No lock is acquired for reads; this is safe because writes use atomic rename.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const result = await loadConfig();
 * if (result.ok) {
 *   console.log(`Instances configured: ${result.value.instances.length}`);
 * }
 * ```
 */
export async function loadConfig(paths: ConfigStorePaths = defaultConfigStorePaths()): Promise<Result<DevboxConfig, DevboxError>> {
  try {
    const raw = await readFile(paths.configFile, "utf8");
    return parseConfigJson(raw);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return ok(synthesizeFirstRunConfig());
    }
    return err(makeError("ConfigError", "failed to read config", [`${error}`]));
  }
}

/**
 * Commit a full config snapshot using lock + temp + fsync + atomic rename.
 *
 * @param nextConfig - Schema-valid next config state. Must satisfy `parseConfig` invariants.
 * @param paths - Optional path override for tests; defaults to `defaultConfigStorePaths()`.
 * @returns On success (`ok`): `undefined` — the config is durably persisted and the lock released.
 *   On error (`err`): `ConfigError` when directory creation fails, lock acquisition fails
 *   (held by another process), temp file write/fsync fails, atomic rename fails, or
 *   directory fsync fails.
 *
 * @remarks
 * Precondition: `nextConfig` is a valid `DevboxConfig`; the process has write access.
 * Postcondition: on success, the config file atomically reflects `nextConfig` and the lock is released.
 * Invariant: the lock file is always released in the finally block, even on failure.
 *
 * ## Durability model
 *
 * The commit uses a four-phase protocol to guarantee crash consistency:
 * 1. **Write temp file**: serialized config is written to a unique temp path.
 * 2. **fsync temp file**: ensures bytes are on stable storage before the rename.
 * 3. **Atomic rename**: `rename(2)` atomically replaces the config file. Readers
 *    always see either the complete old or complete new config.
 * 4. **fsync directory**: hardens the directory entry so the rename survives power loss.
 *
 * A post-rename file fsync is intentionally omitted because the data was already
 * synced in step 2; only the directory metadata needs hardening after rename.
 *
 * @throws Never throws. All failures are captured in the returned Result.
 *
 * @example
 * ```ts
 * const loadResult = await loadConfig();
 * if (loadResult.ok) {
 *   const updated = { ...loadResult.value, lastModified: Date.now() };
 *   const commitResult = await commitConfig(updated);
 *   if (!commitResult.ok) {
 *     console.error(`Commit failed: ${commitResult.error.message}`);
 *   }
 * }
 * ```
 */
export async function commitConfig(
  nextConfig: DevboxConfig,
  paths: ConfigStorePaths = defaultConfigStorePaths(),
): Promise<Result<void, DevboxError>> {
  const ensureDirectoryResult = await ensureDirectory(paths);
  if (!ensureDirectoryResult.ok) {
    return ensureDirectoryResult;
  }

  const lockResult = await acquireLock(paths);
  if (!lockResult.ok) {
    return lockResult;
  }

  const tempPath = `${paths.configFile}.tmp.${randomUUID()}`;
  try {
    const serialized = serializeConfig(nextConfig);

    // Phase 1: Write serialized config to a uniquely-named temp file.
    // Using a UUID in the name prevents collisions if a prior crash left a temp file behind.
    await writeFile(tempPath, serialized, {
      mode: CONFIG_FILE_MODE,
      encoding: "utf8",
      flag: "w",
    });

    // Phase 2: fsync the temp file to ensure data reaches stable storage.
    // Without this, a crash after rename could leave the config file pointing to
    // a file whose data blocks haven't been flushed — resulting in zero-length or garbage.
    const tempSyncResult = await fsyncPath(tempPath);
    if (!tempSyncResult.ok) {
      return tempSyncResult;
    }

    // Phase 3: Atomic rename replaces the config file in a single operation.
    // On POSIX, rename(2) is atomic within a filesystem — readers see either old or new content.
    await rename(tempPath, paths.configFile);

    // Phase 4: fsync the containing directory to harden the rename's metadata change.
    // Without this, a power failure could revert the directory to its pre-rename state,
    // making the config file disappear even though the data blocks are intact.
    const dirSyncResult = await fsyncPath(paths.directory);
    if (!dirSyncResult.ok) {
      return dirSyncResult;
    }

    return ok(undefined);
  } catch (error: unknown) {
    return err(makeError("ConfigError", "failed to commit config atomically", [`${error}`]));
  } finally {
    try {
      await unlink(tempPath);
    } catch {
      // Best effort temp cleanup; atomic rename may already have removed this path.
    }
    await removeLock(paths);
  }
}
