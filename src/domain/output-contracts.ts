import { renderErrorLines, type DevboxError } from "./errors.js";

/**
 * Row model for list output rendering.
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
 */
export interface CommandOutput {
  readonly stdoutLines: readonly string[];
  readonly stderrLines: readonly string[];
  readonly exitCode?: number;
}

/**
 * Build top-level version output lines.
 *
 * @param version CLI version
 * @returns one-line stdout output
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
 * @param version CLI version
 * @returns help and version information
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
 * @returns one-line empty-state message
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
 * Render list table output with required columns.
 *
 * @param rows rows to render
 * @returns table-formatted output
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
 * Convert normalized error into stderr contract lines.
 *
 * @param error normalized error
 * @returns output with empty stdout and formatted stderr lines
 */
export function renderFailure(error: DevboxError): CommandOutput {
  return {
    stdoutLines: [],
    stderrLines: renderErrorLines(error),
  };
}
