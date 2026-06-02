import { describe, expect, it } from "vitest";
import { mapInitPayload } from "../src/domain/init-mapper.js";
import { synthesizeFirstRunConfig } from "../src/domain/config-schema.js";

function baseConfig() {
  const cfg = synthesizeFirstRunConfig();
  return {
    ...cfg,
    defaults: {
      ...cfg.defaults,
      ImageId: "ami-123",
      IamInstanceProfile: { Name: "AmazonSSMRoleForInstancesQuickSetup" },
    },
  };
}

describe("init mapper contracts", () => {
  it("adds MinCount/MaxCount, merges defaults, and forces Name tag", () => {
    const payload = mapInitPayload(
      "workbox",
      {
        InstanceType: "t3.small",
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [
              { Key: "Name", Value: "ignore-me" },
              { Key: "team", Value: "platform" },
            ],
          },
        ],
      },
      baseConfig(),
    );

    expect(payload.MinCount).toBe(1);
    expect(payload.MaxCount).toBe(1);
    expect(payload.ImageId).toBe("ami-123");
    expect(payload.IamInstanceProfile).toEqual({ Name: "AmazonSSMRoleForInstancesQuickSetup" });
    const instanceSpec = (payload.TagSpecifications as Array<{ ResourceType: string; Tags?: Array<{ Key: string; Value: string }> }>).find(
      (x) => x.ResourceType === "instance",
    );
    const tags = Object.fromEntries((instanceSpec?.Tags ?? []).map((t) => [t.Key, t.Value]));
    expect(tags.Name).toBe("workbox");
    expect(tags.team).toBe("platform");
  });

  it("rejects unknown fields", () => {
    expect(() =>
      mapInitPayload(
        "workbox",
        { UnknownThing: true } as Record<string, unknown>,
        baseConfig(),
      ),
    ).toThrow("Unknown template field");
  });

  it("rejects NetworkInterfaces conflicts", () => {
    expect(() =>
      mapInitPayload(
        "workbox",
        {
          NetworkInterfaces: [{ DeviceIndex: 0, Groups: ["sg-123"] }],
          SecurityGroupIds: ["sg-xyz"],
        },
        baseConfig(),
      ),
    ).toThrow("SecurityGroupIds is invalid");
  });

  it("fails when ImageId missing after merge", () => {
    const cfg = synthesizeFirstRunConfig();
    expect(() =>
      mapInitPayload(
        "workbox",
        { IamInstanceProfile: { Name: "x" } },
        cfg,
      ),
    ).toThrow("ImageId is required");
  });

  it("passes UserData through unchanged", () => {
    const userData = "file:~/bootstrap.sh";
    const payload = mapInitPayload("workbox", { UserData: userData }, baseConfig());
    expect(payload.UserData).toBe(userData);
  });
});
