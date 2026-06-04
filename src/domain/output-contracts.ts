import { renderErrorLines, type DevboxError } from "./errors.js";

/**
 * Row model for list output rendering.
 *
 * @remarks
 * Invariant: all string fields are non-empty.
 * `isCurrent` indicates the currently selected box (displayed as `*`).
 */
export interface ListRow {
  readonly isCurrent: boolean;
  readonly alias: string;
  readonly instanceId: string;
  readonly instanceType: string;
  readonly state: string;
}

/**
 * Resulting process output for a command.
 *
 * @remarks
 * `stdoutLines` goes to stdout; `stderrLines` goes to stderr.
 * `exitCode` is set for failure outputs; omitted for success (implying 0).
 */
export interface CommandOutput {
  readonly stdoutLines: readonly string[];
  readonly stderrLines: readonly string[];
  readonly exitCode?: number;
}

/**
 * Build top-level version output lines.
 *
 * @param version - CLI version string (e.g., "1.0.0")
 * @returns `CommandOutput` with a single stdout line in the form `devbox <version>`
 *
 * @remarks
 * Precondition: `version` is a non-empty string.
 * Postcondition: stdout has exactly one line; stderr is empty.
 *
 * @example
 * ```ts
 * import { renderVersion } from "./output-contracts.js";
 *
 * const output = renderVersion("1.2.3");
 * // output.stdoutLines[0] === "devbox 1.2.3"
 * ```
 */
export function renderVersion(version: string): CommandOutput {
  return {
    stdoutLines: [`devbox ${version}`],
    stderrLines: [],
  };
}

/**
 * Build top-level help output lines.
 *
 * @param version - CLI version string for the header line
 * @returns `CommandOutput` with help text on stdout
 *
 * @remarks
 * Precondition: `version` is a non-empty string.
 * Postcondition: stdout contains version line, usage, commands, and flags sections.
 *
 * @example
 * ```ts
 * import { renderHelp } from "./output-contracts.js";
 *
 * const output = renderHelp("1.2.3");
 * // output.stdoutLines[0] === "devbox 1.2.3"
 * // output.stdoutLines includes "Usage:" and "Commands:" sections
 * ```
 */
export function renderHelp(version: string): CommandOutput {
  return {
    stdoutLines: [
      `devbox ${version}`,
      "",
      "Usage:",
      "  devbox [command]",
      "",
      "Commands:",
      "  list                       List tracked boxes",
      "  init <alias> <template>    Launch and track a new instance",
      "  add <instance-id> <alias>  Track an existing instance",
      "  rm <alias> [--terminate]   Remove tracked alias",
      "  switch <alias>             Set current alias",
      "  up                         Start current instance",
      "  down                       Stop current instance",
      "  connect [--ssh-user <u>]   Connect to current instance",
      "  cp [--ssh-user <u>] <l> <r>  Upload local file",
      "",
      "Top-level flags:",
      "  -h, --help                 Print help and version",
      "  -v, --version              Print version",
    ],
    stderrLines: [],
  };
}

/**
 * Render list output for empty tracking state.
 *
 * @returns `CommandOutput` with a single informational stdout line
 *
 * @remarks
 * Postcondition: stdout has exactly one line "No boxes tracked"; stderr is empty.
 *
 * @example
 * ```ts
 * import { renderNoBoxesTracked } from "./output-contracts.js";
 *
 * const output = renderNoBoxesTracked();
 * // output.stdoutLines[0] === "No boxes tracked"
 * ```
 */
export function renderNoBoxesTracked(): CommandOutput {
  return {
    stdoutLines: ["No boxes tracked"],
    stderrLines: [],
  };
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return `${value}${" ".repeat(width - value.length)}`;
}

/**
 * Render list table output with required columns and dynamic column widths.
 *
 * @param rows - non-empty array of `ListRow` entries to render
 * @returns table-formatted output with header row and aligned columns
 *
 * @remarks
 * Precondition: `rows` is non-empty (use `renderNoBoxesTracked` for empty state).
 * Postcondition: output contains one header line followed by one line per row, with `*` marking current.
 * Invariant: column widths are computed from the maximum of header and data widths.
 *
 * @example
 * ```ts
 * import { renderListTable } from "./output-contracts.js";
 *
 * const output = renderListTable([
 *   { isCurrent: true, alias: "dev1", instanceId: "i-abc", instanceType: "t3.micro", state: "running" },
 * ]);
 * // output.stdoutLines[0] contains column headers
 * // output.stdoutLines[1] starts with "* dev1 ..."
 * ```
 */
export function renderListTable(rows: readonly ListRow[]): CommandOutput {
  const aliasWidth = Math.max("alias".length, ...rows.map((row) => row.alias.length));
  const instanceWidth = Math.max("instance-id".length, ...rows.map((row) => row.instanceId.length));
  const typeWidth = Math.max("instance-type".length, ...rows.map((row) => row.instanceType.length));
  const stateWidth = Math.max("state".length, ...rows.map((row) => row.state.length));

  const lines: string[] = [];
  lines.push(
    `${pad(" ", 1)} ${pad("alias", aliasWidth)} ${pad("instance-id", instanceWidth)} ${pad("instance-type", typeWidth)} ${pad("state", stateWidth)}`,
  );
  for (const row of rows) {
    lines.push(
      `${row.isCurrent ? "*" : " "} ${pad(row.alias, aliasWidth)} ${pad(row.instanceId, instanceWidth)} ${pad(row.instanceType, typeWidth)} ${pad(row.state, stateWidth)}`,
    );
  }

  return {
    stdoutLines: lines,
    stderrLines: [],
  };
}

/**
 * Convert a normalized error into the stderr output contract.
 *
 * @param error - normalized `DevboxError` to render
 * @returns `CommandOutput` with empty stdout and formatted stderr lines
 *
 * @remarks
 * Precondition: `error` is a well-formed `DevboxError` from `makeError`.
 * Postcondition: stderr lines follow the `[devbox] <category>: <message>` format with optional detail lines.
 * Invariant: stdout is always empty for failure output.
 *
 * @example
 * ```ts
 * import { renderFailure } from "./output-contracts.js";
 * import { makeError } from "./errors.js";
 *
 * const output = renderFailure(makeError("NotFoundError", "box not found"));
 * // output.stdoutLines.length === 0
 * // output.stderrLines[0] === "[devbox] NotFoundError: box not found"
 * ```
 */
export function renderFailure(error: DevboxError): CommandOutput {
  return {
    stdoutLines: [],
    stderrLines: renderErrorLines(error),
  };
}
