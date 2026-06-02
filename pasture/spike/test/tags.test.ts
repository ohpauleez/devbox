import { describe, expect, it } from "vitest";
import { mergeInstanceTags } from "../src/domain/tags.js";

describe("tag merge policy", () => {
  it("forces Name tag and merges instance tags", () => {
    const merged = mergeInstanceTags(
      "workbox",
      {
        env: "dev",
        service: "devbox",
        version: "1234567",
        "customer-data": "false",
        team: "eng",
      },
      [
        {
          ResourceType: "instance",
          Tags: [
            { Key: "Name", Value: "ignored" },
            { Key: "team", Value: "platform" },
          ],
        },
      ],
    );

    const inst = merged.find((x) => x.ResourceType === "instance");
    const tags = Object.fromEntries((inst?.Tags ?? []).map((t) => [t.Key, t.Value]));
    expect(tags.Name).toBe("workbox");
    expect(tags.team).toBe("platform");
  });
});
