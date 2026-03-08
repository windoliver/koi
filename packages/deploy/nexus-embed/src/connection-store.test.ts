import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConnectionState,
  removeConnectionState,
  writeConnectionState,
} from "./connection-store.js";
import type { ConnectionState } from "./types.js";

describe("connection-store", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nexus-embed-conn-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("writeConnectionState + readConnectionState roundtrip", () => {
    test("writes and reads back identical state", () => {
      const state: ConnectionState = {
        port: 2026,
        pid: 12345,
        host: "127.0.0.1",
        profile: "lite",
        startedAt: "2026-01-01T00:00:00.000Z",
      };

      writeConnectionState(tempDir, state);
      const read = readConnectionState(tempDir);

      expect(read).toEqual(state);
    });

    test("creates nested directories if needed", () => {
      const nested = join(tempDir, "deep", "nested");
      const state: ConnectionState = {
        port: 3000,
        pid: 99999,
        host: "localhost",
        profile: "full",
        startedAt: "2026-03-07T12:00:00.000Z",
      };

      writeConnectionState(nested, state);
      const read = readConnectionState(nested);

      expect(read).toEqual(state);
    });
  });

  describe("readConnectionState", () => {
    test("returns undefined when file does not exist", () => {
      const result = readConnectionState(tempDir);
      expect(result).toBeUndefined();
    });

    test("returns undefined for corrupt JSON", () => {
      writeFileSync(join(tempDir, "embed.json"), "not valid json{{{");
      const result = readConnectionState(tempDir);
      expect(result).toBeUndefined();
    });

    test("returns undefined for JSON that is not an object", () => {
      writeFileSync(join(tempDir, "embed.json"), '"just a string"');
      const result = readConnectionState(tempDir);
      expect(result).toBeUndefined();
    });

    test("returns undefined for JSON array", () => {
      writeFileSync(join(tempDir, "embed.json"), "[1, 2, 3]");
      const result = readConnectionState(tempDir);
      expect(result).toBeUndefined();
    });

    test("returns undefined when port is missing", () => {
      writeFileSync(join(tempDir, "embed.json"), JSON.stringify({ pid: 123, host: "127.0.0.1" }));
      const result = readConnectionState(tempDir);
      expect(result).toBeUndefined();
    });

    test("returns undefined when pid is missing", () => {
      writeFileSync(join(tempDir, "embed.json"), JSON.stringify({ port: 2026, host: "127.0.0.1" }));
      const result = readConnectionState(tempDir);
      expect(result).toBeUndefined();
    });

    test("returns undefined when port is not a number", () => {
      writeFileSync(join(tempDir, "embed.json"), JSON.stringify({ port: "2026", pid: 123 }));
      const result = readConnectionState(tempDir);
      expect(result).toBeUndefined();
    });
  });

  describe("removeConnectionState", () => {
    test("removes existing state file", () => {
      const state: ConnectionState = {
        port: 2026,
        pid: 12345,
        host: "127.0.0.1",
        profile: "lite",
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      writeConnectionState(tempDir, state);

      removeConnectionState(tempDir);
      const result = readConnectionState(tempDir);
      expect(result).toBeUndefined();
    });

    test("handles missing file gracefully", () => {
      expect(() => removeConnectionState(tempDir)).not.toThrow();
    });
  });
});
