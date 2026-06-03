import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeError, type DevboxError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

/**
 * Read package version from package metadata.
 *
 * @returns package version string
 */
export async function readPackageVersion(): Promise<Result<string, DevboxError>> {
  try {
    const packageJsonPathResult = await findNearestPackageJsonPath();
    if (!packageJsonPathResult.ok) {
      return packageJsonPathResult;
    }

    const raw = await readFile(packageJsonPathResult.value, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
      return err(makeError("ConfigError", "package.json version field is missing or invalid"));
    }
    return ok(parsed.version);
  } catch (error: unknown) {
    return err(makeError("ConfigError", "failed to read package version", [`${error}`]));
  }
}

async function findNearestPackageJsonPath(): Promise<Result<string, DevboxError>> {
  let cursor = dirname(fileURLToPath(import.meta.url));
  const maxDepth = 8;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = join(cursor, "package.json");
    try {
      await access(candidate);
      return ok(candidate);
    } catch {
      const next = dirname(cursor);
      if (next === cursor) {
        break;
      }
      cursor = next;
    }
  }

  return err(makeError("ConfigError", "could not locate package.json for version resolution"));
}
