import { describe, expect, it } from "vitest";
import { mapAwsError } from "../src/adapters/aws-cli.js";

describe("aws adapter error mapping", () => {
  it("maps InvalidInstanceID.NotFound to NotFoundError", () => {
    const err = mapAwsError("An error occurred (InvalidInstanceID.NotFound) when calling the DescribeInstances operation");
    expect(err.code).toBe("NotFoundError");
  });

  it("maps auth failures", () => {
    const err = mapAwsError("UnauthorizedOperation");
    expect(err.code).toBe("AwsCliError");
    expect(err.message).toContain("authorization");
  });

  it("maps throttling failures", () => {
    const err = mapAwsError("RequestLimitExceeded");
    expect(err.code).toBe("AwsCliError");
    expect(err.message).toContain("throttled");
  });
});
