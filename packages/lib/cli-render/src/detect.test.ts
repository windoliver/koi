import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { detectColorLevel, detectStreamCapabilities, isColorEnabled } from "./detect.js";

// Save and restore env between tests
const VARS = ["FORCE_COLOR", "NO_COLOR", "NODE_DISABLE_COLORS", "COLORTERM", "TERM"] as const;

describe("detectColorLevel", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of VARS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  // FORCE_COLOR overrides everything
  test("FORCE_COLOR=0 returns none", () => {
    process.env.FORCE_COLOR = "0";
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).toBe("none");
  });

  test("FORCE_COLOR=1 returns ansi-16", () => {
    process.env.FORCE_COLOR = "1";
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).toBe("ansi-16");
  });

  test("FORCE_COLOR=2 returns ansi-256", () => {
    process.env.FORCE_COLOR = "2";
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).toBe("ansi-256");
  });

  test("FORCE_COLOR=3 returns ansi-16m", () => {
    process.env.FORCE_COLOR = "3";
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).toBe("ansi-16m");
  });

  test("FORCE_COLOR=1 overrides NO_COLOR=1", () => {
    process.env.FORCE_COLOR = "1";
    process.env.NO_COLOR = "1";
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).toBe("ansi-16");
  });

  // NO_COLOR standard
  test("NO_COLOR=1 returns none", () => {
    process.env.NO_COLOR = "1";
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).toBe("none");
  });

  test("NO_COLOR='' (empty string) disables colors per spec", () => {
    process.env.NO_COLOR = "";
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).toBe("none");
  });

  test("NO_COLOR undefined does NOT disable colors", () => {
    // NO_COLOR is deleted in beforeEach
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).not.toBe("none");
  });

  // NODE_DISABLE_COLORS
  test("NODE_DISABLE_COLORS present returns none", () => {
    process.env.NODE_DISABLE_COLORS = "";
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).toBe("none");
  });

  // TTY detection
  test("non-TTY stream returns none", () => {
    expect(detectColorLevel({ isTTY: false } as NodeJS.WriteStream)).toBe("none");
  });

  test("isTTY undefined returns none", () => {
    expect(detectColorLevel({} as NodeJS.WriteStream)).toBe("none");
  });

  // COLORTERM / TERM
  test("COLORTERM=truecolor returns ansi-16m on TTY", () => {
    process.env.COLORTERM = "truecolor";
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).toBe("ansi-16m");
  });

  test("COLORTERM=24bit returns ansi-16m on TTY", () => {
    process.env.COLORTERM = "24bit";
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).toBe("ansi-16m");
  });

  test("TERM=xterm-256color returns ansi-256 on TTY", () => {
    process.env.TERM = "xterm-256color";
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).toBe("ansi-256");
  });

  test("plain TTY with no env vars returns ansi-16", () => {
    expect(detectColorLevel({ isTTY: true } as NodeJS.WriteStream)).toBe("ansi-16");
  });

  test("no stream argument returns none (no stdout fallback)", () => {
    expect(detectColorLevel()).toBe("none");
  });
});

describe("isColorEnabled", () => {
  test("returns true when colors are supported", () => {
    const saved = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(isColorEnabled({ isTTY: true } as NodeJS.WriteStream)).toBe(true);
    if (saved !== undefined) process.env.FORCE_COLOR = saved;
    else delete process.env.FORCE_COLOR;
  });

  test("returns false when colors are not supported", () => {
    expect(isColorEnabled({} as NodeJS.WriteStream)).toBe(false);
  });
});

describe("detectTerminal", () => {
  test("returns stdout and stderr capabilities", () => {
    // Import dynamically to avoid module-level side effects
    const { detectTerminal } = require("./detect.js");
    const result = detectTerminal();
    expect(result.stdout).toBeDefined();
    expect(result.stderr).toBeDefined();
    expect(typeof result.stdout.isTTY).toBe("boolean");
    expect(typeof result.stderr.isTTY).toBe("boolean");
    expect(typeof result.stdout.columns).toBe("number");
    expect(typeof result.stderr.columns).toBe("number");
  });
});

describe("detectStreamCapabilities", () => {
  test("returns TTY capabilities for TTY stream", () => {
    const result = detectStreamCapabilities({
      isTTY: true,
      columns: 120,
      write: () => true,
    } as unknown as NodeJS.WritableStream);
    expect(result.isTTY).toBe(true);
    expect(result.columns).toBe(120);
  });

  test("returns non-TTY defaults for piped stream", () => {
    const result = detectStreamCapabilities({
      write: () => true,
    } as unknown as NodeJS.WritableStream);
    expect(result.isTTY).toBe(false);
    expect(result.columns).toBe(80);
    expect(result.colorLevel).toBe("none");
  });
});
