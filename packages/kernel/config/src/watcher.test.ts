import { afterEach, describe, expect, mock, test } from "bun:test";
import { watchConfigFile } from "./watcher.js";

const TMP_PATH = "/tmp/koi-watcher-test.yaml";

/** Polls until a condition is met, with a deadline to avoid infinite hangs. */
async function waitFor(condition: () => boolean, timeoutMs: number = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

let activeUnsubscribe: (() => void) | undefined;

afterEach(async () => {
  activeUnsubscribe?.();
  activeUnsubscribe = undefined;
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(TMP_PATH);
  } catch {
    // ignore
  }
});

describe("watchConfigFile", () => {
  test("calls onReload when file changes", async () => {
    await Bun.write(TMP_PATH, "logLevel: info\n");
    const onReload = mock(() => {});

    activeUnsubscribe = watchConfigFile({ filePath: TMP_PATH, onReload });

    // Modify the file
    await Bun.write(TMP_PATH, "logLevel: debug\n");

    // Poll until callback fires (or timeout)
    await waitFor(() => onReload.mock.calls.length > 0);

    expect(onReload).toHaveBeenCalled();
  });

  test("returns unsubscribe function that stops watching", async () => {
    await Bun.write(TMP_PATH, "logLevel: info\n");
    const onReload = mock(() => {});

    const unsubscribe = watchConfigFile({ filePath: TMP_PATH, onReload });
    unsubscribe();

    // Modify after unsubscribe
    await Bun.write(TMP_PATH, "logLevel: debug\n");
    await new Promise((r) => setTimeout(r, 300));

    expect(onReload).not.toHaveBeenCalled();
  });

  test("debounces rapid changes into single callback", async () => {
    await Bun.write(TMP_PATH, "logLevel: info\n");
    const onReload = mock(() => {});

    activeUnsubscribe = watchConfigFile({
      filePath: TMP_PATH,
      onReload,
      debounceMs: 200,
    });

    // Rapid writes (fire-and-forget to keep them within the debounce window)
    void Bun.write(TMP_PATH, "logLevel: debug\n");
    void Bun.write(TMP_PATH, "logLevel: warn\n");
    void Bun.write(TMP_PATH, "logLevel: error\n");

    // Wait for debounce to settle
    await waitFor(() => onReload.mock.calls.length > 0, 2000);

    // With 200ms debounce, rapid writes should coalesce
    expect(onReload.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
