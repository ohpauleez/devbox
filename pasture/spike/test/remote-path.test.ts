import { describe, expect, it } from "vitest";
import { validateRemotePath } from "../src/domain/remote-path.js";

describe("remote path validation", () => {
  it("accepts normal remote paths", () => {
    expect(() => validateRemotePath("/tmp/file.txt")).not.toThrow();
  });

  it("rejects empty values", () => {
    expect(() => validateRemotePath("   ")).toThrow("Remote path must be non-empty");
  });

  it("rejects newline and control chars", () => {
    expect(() => validateRemotePath("/tmp/a\n.txt")).toThrow("ASCII control");
    expect(() => validateRemotePath("/tmp/a\u0001.txt")).toThrow("ASCII control");
  });
});
