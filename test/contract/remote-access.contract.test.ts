import { describe, expect, it } from "vitest";
import { parseRemotePath } from "../../src/domain/remote-path.js";
import { resolveSshUser } from "../../src/domain/ssh-user.js";
import { resolveCurrentBox } from "../../src/domain/context.js";
import type { BoxAlias, BoxConfig, DefaultsConfig, DevboxConfig, InstanceId, SshUser } from "../../src/domain/types.js";

describe("parseRemotePath", () => {
  it("accepts valid paths", () => {
    expect(parseRemotePath("/home/user/file.txt").ok).toBe(true);
    expect(parseRemotePath("relative/path").ok).toBe(true);
  });

  it("rejects empty", () => {
    const result = parseRemotePath("");
    expect(result.ok).toBe(false);
  });

  it("rejects whitespace-only", () => {
    const result = parseRemotePath("   ");
    expect(result.ok).toBe(false);
  });

  it("rejects control chars", () => {
    const result = parseRemotePath("/home/user/\x01file");
    expect(result.ok).toBe(false);
  });

  it("rejects null bytes", () => {
    const result = parseRemotePath("/home/user/\x00file");
    expect(result.ok).toBe(false);
  });
});

describe("resolveSshUser", () => {
  const box: BoxConfig = { instanceId: "i-123" as InstanceId };
  const boxWithUser: BoxConfig = { instanceId: "i-123" as InstanceId, sshUser: "boxuser" as SshUser };
  const defaults: DefaultsConfig = { tags: { env: "dev", service: "devbox", version: "0000000", "customer-data": "false", team: "devbox" } };
  const defaultsWithUser: DefaultsConfig = { ...defaults, sshUser: "defaultuser" as SshUser };

  it("invocation override wins", () => {
    const result = resolveSshUser({ invocationOverride: "cliuser", box: boxWithUser, defaults: defaultsWithUser });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("cliuser");
  });

  it("box override wins over defaults", () => {
    const result = resolveSshUser({ box: boxWithUser, defaults: defaultsWithUser });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("boxuser");
  });

  it("defaults used as fallback", () => {
    const result = resolveSshUser({ box, defaults: defaultsWithUser });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("defaultuser");
  });

  it("missing all three fails", () => {
    const result = resolveSshUser({ box, defaults });
    expect(result.ok).toBe(false);
  });
});

describe("resolveCurrentBox", () => {
  const boxConfig: BoxConfig = { instanceId: "i-abc" as InstanceId };
  const validDefaults: DefaultsConfig = { tags: { env: "dev", service: "devbox", version: "0000000", "customer-data": "false", team: "devbox" } };

  it("no current -> error", () => {
    const config: DevboxConfig = { boxes: { mybox: boxConfig } as Record<BoxAlias, BoxConfig>, defaults: validDefaults };
    const result = resolveCurrentBox(config);
    expect(result.ok).toBe(false);
  });

  it("current not in boxes -> error", () => {
    const config: DevboxConfig = {
      boxes: { mybox: boxConfig } as Record<BoxAlias, BoxConfig>,
      defaults: validDefaults,
      current: "ghost" as BoxAlias,
    };
    const result = resolveCurrentBox(config);
    expect(result.ok).toBe(false);
  });

  it("valid -> success", () => {
    const config: DevboxConfig = {
      boxes: { mybox: boxConfig } as Record<BoxAlias, BoxConfig>,
      defaults: validDefaults,
      current: "mybox" as BoxAlias,
    };
    const result = resolveCurrentBox(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.alias).toBe("mybox");
      expect(result.value.box).toEqual(boxConfig);
    }
  });
});
