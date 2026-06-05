import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { traceSpec } from "../support/spec-trace.js";

import {
  buildCanonicalCatalogFromFiles,
  createCanonicalCatalog,
  discoverCanonicalSpecFiles,
} from "../support/spec-trace/catalog.js";
import { scanSpecMarkdown } from "../support/spec-trace/scan.js";

/**
 * Create a temporary file with any missing parent directories.
 *
 * @param filePath - file to create
 * @param content - file contents
 */
async function writeTempFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

describe("spec trace catalog discovery", () => {
  it("includes canonical specs and active changes but excludes archive and unrelated paths", async () => {
    traceSpec("TRACE-CATALOG-SCOPE", "TRACE-CATALOG-INCLUDE", "TRACE-CATALOG-EXCLUDE");

    const rootDir = await mkdtemp(join(tmpdir(), "devbox-spec-trace-"));
    const includedSpec = join(rootDir, "openspec/specs/capability/spec.md");
    const activeChangeSpec = join(rootDir, "openspec/changes/change-a/specs/capability/spec.md");
    const archivedChangeSpec = join(rootDir, "openspec/changes/archive/old/specs/capability/spec.md");
    const schemaTemplate = join(rootDir, "openspec/schemas/srs-driven/templates/spec.md");
    const unrelatedMarkdown = join(rootDir, "openspec/specs/capability/notes.md");

    await writeTempFile(includedSpec, "### Requirement: Included [TRACE-INCLUDE-A]\n");
    await writeTempFile(activeChangeSpec, "### Requirement: Included [TRACE-INCLUDE-B]\n");
    await writeTempFile(archivedChangeSpec, "### Requirement: Excluded [TRACE-EXCLUDE-A]\n");
    await writeTempFile(schemaTemplate, "### Requirement: Excluded [TRACE-EXCLUDE-B]\n");
    await writeTempFile(unrelatedMarkdown, "### Requirement: Excluded [TRACE-EXCLUDE-C]\n");

    expect(discoverCanonicalSpecFiles(rootDir)).toEqual([activeChangeSpec, includedSpec]);
  });
});

describe("spec trace markdown scanner", () => {
  it("extracts bracketed identifiers and keeps nearest heading provenance", () => {
    traceSpec("TRACE-ID-SYNTAX", "TRACE-ID-EXTRACT", "TRACE-CATALOG-PROVENANCE", "TRACE-PROVENANCE-HEADING");

    const markdown = [
      "### Requirement: Catalog scope [TRACE-CATALOG-SCOPE]",
      "Normal prose mentioning [TRACE-CATALOG-INCLUDE].",
      "#### Scenario: Included path contributes [TRACE-CATALOG-INCLUDE-SCENARIO]",
      "Follow-up prose with [TRACE-CATALOG-POST].",
    ].join("\n");

    expect(scanSpecMarkdown("spec.md", markdown)).toEqual([
      {
        identifier: "TRACE-CATALOG-SCOPE",
        file: "spec.md",
        line: 1,
        heading: "Requirement: Catalog scope",
      },
      {
        identifier: "TRACE-CATALOG-INCLUDE",
        file: "spec.md",
        line: 2,
        heading: "Requirement: Catalog scope",
      },
      {
        identifier: "TRACE-CATALOG-INCLUDE-SCENARIO",
        file: "spec.md",
        line: 3,
        heading: "Scenario: Included path contributes",
      },
      {
        identifier: "TRACE-CATALOG-POST",
        file: "spec.md",
        line: 4,
        heading: "Scenario: Included path contributes",
      },
    ]);
  });

  it("ignores bare tokens, inline code, and fenced code blocks", () => {
    traceSpec("TRACE-CATALOG-CODE", "TRACE-ID-IGNORE", "TRACE-CODE-INLINE", "TRACE-CODE-FENCE");

    const markdown = [
      "### Requirement: Syntax [TRACE-ID-SYNTAX]",
      "A bare TRACE-ID-IGNORE token must not count.",
      "Inline code `[TRACE-INLINE-IGNORE]` must not count either.",
      "```ts",
      "const x = '[TRACE-FENCE-IGNORE]';",
      "```",
      "Visible prose still counts [TRACE-VISIBLE-KEEP].",
    ].join("\n");

    expect(scanSpecMarkdown("spec.md", markdown).map((entry) => entry.identifier)).toEqual([
      "TRACE-ID-SYNTAX",
      "TRACE-VISIBLE-KEEP",
    ]);
  });
});

describe("spec trace canonical catalog", () => {
  it("keeps the first same-file occurrence and rejects cross-file duplicates", async () => {
    traceSpec("TRACE-DIAG-DUPE", "TRACE-DUPE-CROSSFILE", "TRACE-DUPE-SAMEFILE");

    const rootDir = await mkdtemp(join(tmpdir(), "devbox-spec-trace-"));
    const firstFile = join(rootDir, "openspec/specs/one/spec.md");
    const secondFile = join(rootDir, "openspec/specs/two/spec.md");

    await writeTempFile(
      firstFile,
      [
        "### Requirement: One [TRACE-DUPE-SAMEFILE]",
        "Repeated [TRACE-DUPE-SAMEFILE] stays local.",
      ].join("\n"),
    );
    await writeTempFile(secondFile, "### Requirement: Two [TRACE-DUPE-SAMEFILE]\n");

    const localOnlyCatalog = buildCanonicalCatalogFromFiles([firstFile]);
    expect(localOnlyCatalog.entriesByIdentifier.get("TRACE-DUPE-SAMEFILE")).toEqual({
      identifier: "TRACE-DUPE-SAMEFILE",
      file: firstFile,
      line: 1,
      heading: "Requirement: One",
    });

    expect(() => buildCanonicalCatalogFromFiles([firstFile, secondFile])).toThrowError(
      /Duplicate canonical identifier TRACE-DUPE-SAMEFILE/u,
    );
  });

  it("supports empty catalogs", () => {
    expect(createCanonicalCatalog([]).identifiers).toEqual([]);
    expect(buildCanonicalCatalogFromFiles([]).identifiers).toEqual([]);
  });
});
