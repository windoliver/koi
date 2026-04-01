import { describe, expect, mock, test } from "bun:test";
import { createDebounce } from "./debounce.js";

describe("createDebounce", () => {
  test("delays execution by delayMs", async () => {
    const fn = mock(() => {});
    const debounced = createDebounce(fn, 15);

    debounced.call();
    expect(fn).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 25));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("coalesces rapid calls into single execution", async () => {
    const fn = mock(() => {});
    const debounced = createDebounce(fn, 20);

    debounced.call();
    debounced.call();
    debounced.call();

    await new Promise((r) => setTimeout(r, 40));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("passes latest arguments to the function", async () => {
    const fn = mock((_x: number) => {});
    const debounced = createDebounce(fn, 15);

    debounced.call(1);
    debounced.call(2);
    debounced.call(3);

    await new Promise((r) => setTimeout(r, 30));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  test("cancel prevents pending invocation", async () => {
    const fn = mock(() => {});
    const debounced = createDebounce(fn, 15);

    debounced.call();
    debounced.cancel();

    await new Promise((r) => setTimeout(r, 30));
    expect(fn).not.toHaveBeenCalled();
  });

  test("flush invokes immediately if call is pending", () => {
    const fn = mock((_x: string) => {});
    const debounced = createDebounce(fn, 1000);

    debounced.call("flushed");
    debounced.flush();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("flushed");
  });

  test("flush is no-op when nothing is pending", () => {
    const fn = mock(() => {});
    const debounced = createDebounce(fn, 1000);

    debounced.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  test("flush cancels the timer", async () => {
    const fn = mock(() => {});
    const debounced = createDebounce(fn, 15);

    debounced.call();
    debounced.flush();

    await new Promise((r) => setTimeout(r, 30));
    // Should only have been called once (the flush), not twice (flush + timer)
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("can be called again after cancel", async () => {
    const fn = mock(() => {});
    const debounced = createDebounce(fn, 15);

    debounced.call();
    debounced.cancel();
    debounced.call();

    await new Promise((r) => setTimeout(r, 30));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
