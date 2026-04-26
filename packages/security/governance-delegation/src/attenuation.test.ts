import { describe, expect, test } from "bun:test";
import { isPermissionSubsetWithAsk } from "./attenuation.js";

describe("isPermissionSubsetWithAsk (codex round-4: critical)", () => {
  test("child preserving parent.ask passes", () => {
    expect(
      isPermissionSubsetWithAsk({ allow: ["*"], ask: ["bash"] }, { allow: ["*"], ask: ["bash"] }),
    ).toBe(true);
  });

  test("child stripping parent.ask is rejected (the round-4 forgery class)", () => {
    // Parent says: "delegate everything, but ask before bash".
    // Child says: "delegate everything" with no ask.
    // Without this check, child silently bypasses the human-approval gate.
    expect(isPermissionSubsetWithAsk({ allow: ["*"] }, { allow: ["*"], ask: ["bash"] })).toBe(
      false,
    );
  });

  test("child promoting parent.ask to deny is acceptable attenuation", () => {
    // Deny is strictly more restrictive than ask, so this narrows authority.
    expect(
      isPermissionSubsetWithAsk({ allow: ["*"], deny: ["bash"] }, { allow: ["*"], ask: ["bash"] }),
    ).toBe(true);
  });

  test("child adding new ask entries is acceptable (further restriction)", () => {
    expect(
      isPermissionSubsetWithAsk(
        { allow: ["*"], ask: ["bash", "db:write"] },
        { allow: ["*"], ask: ["bash"] },
      ),
    ).toBe(true);
  });

  test("partial ask preservation rejected — every parent.ask entry must remain or be denied", () => {
    expect(
      isPermissionSubsetWithAsk(
        { allow: ["*"], ask: ["bash"] },
        { allow: ["*"], ask: ["bash", "db:write"] },
      ),
    ).toBe(false);
  });

  test("L0 subset rules still enforced — widening allow rejected", () => {
    expect(isPermissionSubsetWithAsk({ allow: ["*"] }, { allow: ["read_file"] })).toBe(false);
  });

  test("L0 subset rules still enforced — dropping parent.deny rejected", () => {
    expect(isPermissionSubsetWithAsk({ allow: ["*"] }, { allow: ["*"], deny: ["bash"] })).toBe(
      false,
    );
  });

  test("parent without ask leaves child free", () => {
    expect(isPermissionSubsetWithAsk({ allow: ["*"] }, { allow: ["*"] })).toBe(true);
  });
});
