import { describe, expect, test } from "bun:test";

const hasApiKey = process.env.DAYTONA_API_KEY !== undefined;

describe.skipIf(!hasApiKey)("Daytona integration", () => {
  test("placeholder for real Daytona SDK integration", () => {
    expect(hasApiKey).toBe(true);
  });
});
