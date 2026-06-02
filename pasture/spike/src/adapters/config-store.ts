import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { DevboxError } from "../domain/errors.js";
import {
  DevboxConfig,
  parseConfigOrThrow,
  synthesizeFirstRunConfig,
} from "../domain/config-schema.js";

const STALE_LOCK_MAX_AGE_MS = 5 * 60_000;

function configDir(): string {
  return process.env.DEVBOX_CONFIG_DIR ?? path.join(os.homedir(), ".config");
}

function configPath(): string {
  return path.join(configDir(), "devbox.json");
}

function lockPath(): string {
  return path.join(configDir(), "devbox.json.lock");
}

export function getConfigPath(): string {
  return configPath();
}

async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
}

async function readMaybeConfig(): Promise<DevboxConfig> {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    return parseConfigOrThrow(JSON.parse(raw));
  } catch (err) {
    const enoent = err as NodeJS.ErrnoException;
    if (enoent.code === "ENOENT") {
      return synthesizeFirstRunConfig();
    }
    if (err instanceof SyntaxError) {
      throw new DevboxError("ConfigError", "Config is not valid JSON");
    }
    if (err instanceof DevboxError) {
      throw err;
    }
    throw new DevboxError("ConfigError", "Failed to read config");
  }
}

export async function readConfigForList(): Promise<DevboxConfig> {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    return parseConfigOrThrow(JSON.parse(raw));
  } catch (err) {
    const enoent = err as NodeJS.ErrnoException;
    if (enoent.code === "ENOENT") {
      return synthesizeFirstRunConfig();
    }
    if (err instanceof DevboxError) {
      throw err;
    }
    throw new DevboxError("ConfigError", "Failed to load config");
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === "ESRCH") {
      return false;
    }
    if (errno.code === "EPERM") {
      return true;
    }
    return true;
  }
}

async function isLockStale(): Promise<boolean> {
  const lock = lockPath();
  let pidRaw: string;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    [pidRaw, stat] = await Promise.all([fs.readFile(lock, "utf8"), fs.stat(lock)]);
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return false;
    }
    throw new DevboxError("ConfigError", "Failed to inspect config lock");
  }

  const trimmed = pidRaw.trim();
  const pid = Number.parseInt(trimmed, 10);
  if (!trimmed || !Number.isInteger(pid) || pid <= 0) {
    return true;
  }

  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > STALE_LOCK_MAX_AGE_MS) {
    return true;
  }

  return !isProcessAlive(pid);
}

async function recoverStaleLockIfNeeded(): Promise<boolean> {
  const lock = lockPath();
  const stale = await isLockStale();
  if (!stale) {
    return false;
  }
  try {
    await fs.unlink(lock);
    return true;
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return true;
    }
    throw new DevboxError("ConfigError", "Failed to remove stale config lock");
  }
}

async function acquireLock(): Promise<void> {
  const lock = lockPath();
  try {
    await fs.writeFile(lock, String(process.pid), { flag: "wx" });
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === "EEXIST") {
      const recovered = await recoverStaleLockIfNeeded();
      if (recovered) {
        try {
          await fs.writeFile(lock, String(process.pid), { flag: "wx" });
          return;
        } catch (retryErr) {
          const retryErrno = retryErr as NodeJS.ErrnoException;
          if (retryErrno.code === "EEXIST") {
            throw new DevboxError("ConfigError", "Config lock is held by another process");
          }
          throw new DevboxError("ConfigError", "Failed to create config lock");
        }
      }
      throw new DevboxError("ConfigError", "Config lock is held by another process");
    }
    throw new DevboxError("ConfigError", "Failed to create config lock");
  }
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(lockPath());
  } catch {
    // best effort
  }
}

async function fsyncFile(filePath: string): Promise<void> {
  const fh = await fs.open(filePath, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function fsyncDir(dirPath: string): Promise<void> {
  try {
    const fh = await fs.open(dirPath, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // best effort
  }
}

export async function mutateConfig(mutator: (cfg: DevboxConfig) => DevboxConfig): Promise<DevboxConfig> {
  await ensureConfigDir();
  await acquireLock();
  try {
    const current = await readMaybeConfig();
    const next = parseConfigOrThrow(mutator(current));

    const tmpPath = path.join(configDir(), `.devbox.json.tmp.${randomUUID()}`);
    const body = `${JSON.stringify(next, null, 2)}\n`;

    await fs.writeFile(tmpPath, body, { encoding: "utf8", mode: 0o600 });
    await fsyncFile(tmpPath);
    await fs.rename(tmpPath, configPath());
    await fsyncDir(configDir());

    return next;
  } finally {
    await releaseLock();
  }
}
