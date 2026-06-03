import { randomUUID } from "node:crypto";
import {
  access,
  constants,
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

const CONFIG_FILE_MODE = 0o644;
const LOCK_FILE_MODE = 0o644;

/**
 * File path settings for config store.
 */
export interface ConfigStorePaths {
  readonly directory: string;
  readonly configFile: string;
  readonly lockFile: string;
}

/**
 * Compute default config paths.
 *
 * @returns config directory, config file, and lock file paths
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
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      return false;
    }
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function isLockStale(paths: ConfigStorePaths): Promise<Result<boolean, DevboxError>> {
  try {
    const [raw, lockStat] = await Promise.all([
      readFile(paths.lockFile, "utf8"),
      stat(paths.lockFile),
    ]);
    const lockAgeMs = Date.now() - lockStat.mtimeMs;
    if (lockAgeMs > CONFIG_LOCK_STALE_AFTER_MS) {
      return ok(true);
    }
    const parsedPid = parsePid(raw);
    if (parsedPid === undefined) {
      return ok(true);
    }
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

async function acquireLock(paths: ConfigStorePaths): Promise<Result<void, DevboxError>> {
  const lockBody = `${process.pid}\n`;
  try {
    await writeFile(paths.lockFile, lockBody, {
      mode: LOCK_FILE_MODE,
      flag: "wx",
      encoding: "utf8",
    });
    return ok(undefined);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "EEXIST") {
      return err(makeError("ConfigError", "failed to create config lock", [`${error}`]));
    }

    const staleResult = await isLockStale(paths);
    if (!staleResult.ok) {
      return staleResult;
    }
    if (!staleResult.value) {
      return err(makeError("ConfigError", "config lock is held by another active process"));
    }

    try {
      await unlink(paths.lockFile);
    } catch (unlinkError: unknown) {
      const unlinkNodeError = unlinkError as NodeJS.ErrnoException;
      if (unlinkNodeError.code !== "ENOENT") {
        return err(makeError("ConfigError", "failed to remove stale config lock", [`${unlinkError}`]));
      }
    }

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
 * @param paths optional path override for tests
 * @returns parsed config or first-run synthesized config when missing
 */
export async function loadConfig(paths: ConfigStorePaths = defaultConfigStorePaths()): Promise<Result<DevboxConfig, DevboxError>> {
  try {
    await access(paths.configFile, constants.F_OK);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return ok(synthesizeFirstRunConfig());
    }
    return err(makeError("ConfigError", "failed to check config presence", [`${error}`]));
  }

  try {
    const raw = await readFile(paths.configFile, "utf8");
    return parseConfigJson(raw);
  } catch (error: unknown) {
    return err(makeError("ConfigError", "failed to read config", [`${error}`]));
  }
}

/**
 * Commit a full config snapshot using lock + temp + fsync + atomic rename.
 *
 * @param nextConfig schema-valid next config state
 * @param paths optional path override for tests
 * @returns success when commit persisted atomically
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
    await writeFile(tempPath, serialized, {
      mode: CONFIG_FILE_MODE,
      encoding: "utf8",
      flag: "w",
    });

    const tempSyncResult = await fsyncPath(tempPath);
    if (!tempSyncResult.ok) {
      return tempSyncResult;
    }

    await rename(tempPath, paths.configFile);

    const fileSyncResult = await fsyncPath(paths.configFile);
    if (!fileSyncResult.ok) {
      return fileSyncResult;
    }

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
