import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { makeError, type DevboxError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";

const execFileAsync = promisify(execFile);

export interface ProcessSuccess {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Execute a local command using argv invocation without shell interpolation.
 *
 * @param file executable name
 * @param args argument vector
 * @returns stdout/stderr on success or normalized dependency/transport error
 */
export async function runProcess(
  file: string,
  args: readonly string[],
): Promise<Result<ProcessSuccess, DevboxError>> {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return ok({ stdout, stderr });
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException & {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly code?: string | number;
    };

    if (nodeError.code === "ENOENT") {
      return err(makeError("DependencyError", `required executable not found: ${file}`));
    }

    const details: string[] = [];
    if (typeof nodeError.stderr === "string" && nodeError.stderr.trim().length > 0) {
      details.push(...nodeError.stderr.trimEnd().split("\n"));
    }
    if (typeof nodeError.stdout === "string" && nodeError.stdout.trim().length > 0) {
      details.push(...nodeError.stdout.trimEnd().split("\n"));
    }

    return err(makeError("TransportError", `command failed: ${file}`, details));
  }
}
