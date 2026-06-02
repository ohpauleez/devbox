export function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function printNoBoxes(): void {
  printLine("No boxes tracked");
}

export function printListTable(
  rows: Array<{
    current: boolean;
    alias: string;
    instanceId: string;
    state: string;
    instanceType: string;
  }>,
): void {
  const header = ["CUR", "ALIAS", "INSTANCE", "STATE", "TYPE"];
  const body = rows.map((r) => [r.current ? "*" : "", r.alias, r.instanceId, r.state, r.instanceType]);
  const all = [header, ...body];
  const widths = header.map((_, idx) =>
    Math.max(
      ...all.map((r) => {
        const cell = r[idx] ?? "";
        return cell.length;
      }),
    ),
  );
  for (const row of all) {
    const rendered = row
      .map((c, idx) => c.padEnd(widths[idx] ?? 0))
      .join("  ")
      .trimEnd();
    printLine(rendered);
  }
}
