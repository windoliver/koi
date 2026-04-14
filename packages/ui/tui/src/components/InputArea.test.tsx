/**
 * Regression coverage for #1744: keypress events that drain through the
 * renderer's KeyHandler after the textarea's underlying EditBuffer has been
 * destroyed must NOT log "EditBuffer is destroyed" errors. The fix in
 * InputArea.tsx wraps every plainText/setText access so a destroyed buffer
 * is treated as empty / no-op rather than throwing through the keypress
 * listener (which @opentui/core's KeyHandler then logs to console.error).
 */

import { testRender } from "@opentui/solid";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createInitialState } from "../state/initial.js";
import { createStore } from "../state/store.js";
import { StoreContext } from "../store-context.js";
import { InputArea } from "./InputArea.js";

const OPTS = { width: 80, height: 10 };

interface RenderableLike {
  plainText?: string;
  setText?: (t: string) => void;
  getChildren?: () => readonly RenderableLike[];
}

function findEditBufferRenderable(node: RenderableLike): RenderableLike | null {
  if (typeof node.plainText === "string" && typeof node.setText === "function") {
    return node;
  }
  const children = node.getChildren?.() ?? [];
  for (const child of children) {
    const found = findEditBufferRenderable(child);
    if (found !== null) return found;
  }
  return null;
}

describe("InputArea — streaming input gate (#1730)", () => {
  test("disabled=true blocks Enter from reaching onSubmit", async () => {
    // Repro: during streaming, ConversationView passes disabled=true so
    // the input stops accepting keys. InputArea's own useKeyboard handler
    // must bail via disabledRef before dispatching onSubmit, otherwise
    // late-arriving permission keystrokes (y/n/a) and ordinary typing
    // accumulate and surface as ghost user turns when the user next
    // presses Enter (#1730).
    const store = createStore(createInitialState());
    const onSubmit = mock((_text: string) => {});
    const { renderer, mockInput } = await testRender(
      () => (
        <StoreContext.Provider value={store}>
          <InputArea
            onSubmit={onSubmit}
            onSlashDetected={() => {}}
            focused={true}
            disabled={true}
          />
        </StoreContext.Provider>
      ),
      OPTS,
    );
    mockInput.pressKey("y");
    mockInput.pressEnter();
    expect(onSubmit).not.toHaveBeenCalled();
    renderer.destroy();
  });
});

describe("InputArea — destroyed EditBuffer guard (#1744)", () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  async function mountInputArea() {
    const store = createStore(createInitialState());
    const props = {
      onSubmit: mock((_text: string) => {}),
      onSlashDetected: mock((_q: string | null) => {}),
      focused: true,
    };
    const utils = await testRender(
      () => (
        <StoreContext.Provider value={store}>
          <InputArea {...props} />
        </StoreContext.Provider>
      ),
      OPTS,
    );
    await utils.renderOnce();
    return { ...utils, props };
  }

  test("keypress after EditBuffer destruction does not log a KeyHandler error", async () => {
    const { renderer, mockInput } = await mountInputArea();

    const textarea = findEditBufferRenderable(renderer.root as RenderableLike);
    expect(textarea).not.toBeNull();
    if (textarea === null) return;

    // Simulate the post-shutdown race: the textarea Renderable still exists
    // but its EditBuffer has been destroyed by renderer.destroy(). Any read
    // or write throws "EditBuffer is destroyed".
    const destroyError = (): never => {
      throw new Error("EditBuffer is destroyed");
    };
    Object.defineProperty(textarea, "plainText", { get: destroyError, configurable: true });
    textarea.setText = destroyError;

    // Fire a normal character — exercises safeText() inside the keypress
    // callback (insert-char path reads plainText to detect slash/at prefixes).
    mockInput.pressKey("a");
    // Fire Enter — exercises both safeText() and safeSetText() (submit path).
    mockInput.pressEnter();

    const editBufferErrors = errorSpy.mock.calls.filter((call: readonly unknown[]) =>
      call.some(
        (arg: unknown) =>
          typeof arg === "object" && arg !== null && String(arg).includes("EditBuffer is destroyed"),
      ),
    );
    expect(editBufferErrors).toHaveLength(0);

    renderer.destroy();
  });
});
