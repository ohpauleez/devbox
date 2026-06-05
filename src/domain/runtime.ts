/**
 * @module runtime
 *
 * Runtime introspection utilities for the devbox CLI.
 *
 * Provides functions that query the tool's own installation context (e.g.,
 * package version) so that other modules can report accurate metadata without
 * hard-coding values.
 *
 * @remarks
 * All functions in this module return `Result` types rather than throwing,
 * ensuring callers can handle failures uniformly through the domain error system.
 */

import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeTypedError, type ConfigError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

/**
 * Reads the package version from the nearest ancestor `package.json`.
 *
 * Walks up the directory tree from the current module's location, searching
 * for a `package.json` file within a bounded depth, then extracts and
 * validates its `version` field.
 *
 * @returns A `Result` containing the version string on success, or a
 *   `ConfigError` on failure.
 *
 * @remarks
 * **Precondition:** A `package.json` with a valid, non-empty `version` field
 * exists within 8 directory levels above this module's compiled location.
 *
 * **Postcondition:** The returned string is a non-empty, untrimmed-safe
 * version identifier as authored in `package.json`.
 *
 * **Invariant:** Never performs network I/O — only local filesystem access.
 *
 * **Failure forms:**
 * - `ConfigError` — `package.json` not found within traversal depth limit.
 * - `ConfigError` — `package.json` exists but cannot be read or parsed as JSON.
 * - `ConfigError` — `version` field is missing, non-string, or empty/whitespace.
 * - `ConfigError` — Any unexpected filesystem error during traversal.
 *
 * **Safety:** Does not cache results; safe to call multiple times if the
 * filesystem state may change between calls (e.g., during tests).
 *
 * @throws Never throws — all errors are captured in the returned `Result`.
 *
 * @example
 * ```ts
 * import { readPackageVersion } from "./runtime.js";
 *
 * const result = await readPackageVersion();
 * if (result.ok) {
 *   console.log(`Running version ${result.value}`);
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export async function readPackageVersion(): Promise<Result<string, ConfigError>> {
  try {
    const packageJsonPathResult = await findNearestPackageJsonPath();
    if (!packageJsonPathResult.ok) {
      return packageJsonPathResult;
    }

    const raw = await readFile(packageJsonPathResult.value, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
      return err(makeTypedError("ConfigError", "package.json version field is missing or invalid"));
    }
    return ok(parsed.version);
  } catch (error: unknown) {
    return err(makeTypedError("ConfigError", "failed to read package version", [`${error}`]));
  }
}

/**
 * Locates the nearest `package.json` by walking up the directory tree.
 *
 * @returns A `Result` containing the absolute path to `package.json`, or a
 *   `ConfigError` if none is found within the traversal depth limit.
 *
 * @remarks
 * **Precondition:** `import.meta.url` resolves to a valid file path on the
 *   local filesystem.
 * **Postcondition:** The returned path points to an accessible file (verified
 *   via `fs.access` at discovery time).
 * **Invariant:** Traversal is bounded to 8 levels to prevent unbounded
 *   filesystem walking (e.g., if invoked from a deeply nested location with
 *   no package.json above).
 *
 * **Failure forms:**
 * - `ConfigError` — No `package.json` found within 8 ancestor directories.
 * - `ConfigError` — Reached filesystem root before finding `package.json`.
 *
 * @throws Never throws — filesystem errors during `access` are caught and
 *   treated as "not found at this level."
 */
async function findNearestPackageJsonPath(): Promise<Result<string, ConfigError>> {
  let cursor = dirname(fileURLToPath(import.meta.url));
  // Bounded to avoid runaway traversal on misconfigured installations.
  const maxDepth = 8;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = join(cursor, "package.json");
    try {
      await access(candidate);
      return ok(candidate);
    } catch {
      const next = dirname(cursor);
      if (next === cursor) {
        // Reached filesystem root — no further ancestors to check.
        break;
      }
      cursor = next;
    }
  }

  return err(makeTypedError("ConfigError", "could not locate package.json for version resolution"));
}
