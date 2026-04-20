import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderHostWrapper, writeHostWrapper } from "../host-wrapper.js";

describe("host-wrapper", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-browser-ext-wrapper-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("renders the baked node and host entrypoint paths", () => {
    expect(renderHostWrapper("/opt/homebrew/bin/node", "/tmp/native-host.js")).toContain(
      'exec "/opt/homebrew/bin/node" "/tmp/native-host.js" "$@"',
    );
  });

  test("writes the wrapper with executable permissions", async () => {
    const path = join(dir, "bin", "native-host");
    await writeHostWrapper(path, "/opt/homebrew/bin/node", "/tmp/native-host.js");
    expect(await readFile(path, "utf8")).toContain("/opt/homebrew/bin/node");
    expect((await stat(path)).mode & 0o777).toBe(0o755);
  });
});
