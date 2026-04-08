/**
 * SlashOverlay render tests and ConversationView integration tests.
 *
 * Note on <select> rendering: OpenTUI's <select> renders items only when it has
 * a computed height from a flex-grow parent. In standalone testRender with no
 * flex container (unlike TuiRoot which provides one), <select> items may not
 * appear in captureCharFrame(). These tests check the overlay visibility contract
 * (Commands header / No matching commands fallback / hidden) rather than item names.
 */
import { testRender } from "@opentui/solid";
import { describe, expect, test } from "bun:test";
import type { JSX } from "solid-js";
import type { SlashCommand } from "../commands/slash-detection.js";
import { createInitialState } from "../state/initial.js";
import { reduce } from "../state/reduce.js";
import { createStore } from "../state/store.js";
import type { TuiStore } from "../state/store.js";
import type { TuiState } from "../state/types.js";
import { StoreContext } from "../store-context.js";
import { ConversationView } from "./ConversationView.js";
import { SlashOverlay } from "./SlashOverlay.js";

const OPTS = { width: 80, height: 24 };

const SAMPLE_COMMANDS: readonly SlashCommand[] = [
  { name: "clear", description: "Clear all messages" },
  { name: "sessions", description: "Browse sessions" },
  { name: "help", description: "Show help" },
];

function StoreProviders(props: { readonly store: TuiStore; readonly children: JSX.Element }): JSX.Element {
  return (
    <StoreContext.Provider value={props.store}>
      {props.children}
    </StoreContext.Provider>
  );
}

function buildState(actions: ReadonlyArray<Parameters<typeof reduce>[1]>): TuiState {
  let state = createInitialState();
  for (const action of actions) {
    state = reduce(state, action);
  }
  return state;
}

// Note: JSX must be inlined inside the testRender factory — in Solid, createComponent
// runs the component function immediately, so passing <Component/> as an argument
// executes it before the renderer/context is available.

describe("SlashOverlay — render", () => {
  test("matching commands shows Commands header", async () => {
    const store = createStore(createInitialState());
    const { captureCharFrame, renderOnce, renderer } = await testRender(
      () => (
        <StoreProviders store={store}>
          <SlashOverlay
            query="cl"
            commands={SAMPLE_COMMANDS}
            onSelect={() => {}}
            onDismiss={() => {}}
            focused={true}
          />
        </StoreProviders>
      ),
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    renderer.destroy();
    // When matches exist, the Commands header box renders (not the fallback)
    expect(frame).toContain("Commands");
    expect(frame).not.toContain("No matching commands");
  });

  test("no match shows fallback message", async () => {
    const store = createStore(createInitialState());
    const { captureCharFrame, renderOnce, renderer } = await testRender(
      () => (
        <StoreProviders store={store}>
          <SlashOverlay
            query="zzz"
            commands={SAMPLE_COMMANDS}
            onSelect={() => {}}
            onDismiss={() => {}}
            focused={true}
          />
        </StoreProviders>
      ),
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    renderer.destroy();
    expect(frame).toContain("No matching commands");
    expect(frame).not.toContain("Commands");
  });

  test("empty query shows Commands header (all match)", async () => {
    const store = createStore(createInitialState());
    const { captureCharFrame, renderOnce, renderer } = await testRender(
      () => (
        <StoreProviders store={store}>
          <SlashOverlay
            query=""
            commands={SAMPLE_COMMANDS}
            onSelect={() => {}}
            onDismiss={() => {}}
            focused={true}
          />
        </StoreProviders>
      ),
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    renderer.destroy();
    // When all commands match, the Commands header box renders
    expect(frame).toContain("Commands");
    expect(frame).not.toContain("No matching commands");
  });
});

describe("ConversationView — slash overlay integration", () => {
  test("shows overlay when slashQuery set", async () => {
    const state = buildState([{ kind: "set_slash_query", query: "cl" }]);
    const store = createStore(state);
    const { captureCharFrame, renderOnce, renderer } = await testRender(
      () => (
        <StoreProviders store={store}>
          <ConversationView onSubmit={() => {}} onSlashDetected={() => {}} focused={true} />
        </StoreProviders>
      ),
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    renderer.destroy();
    // The SlashOverlay's Commands header is visible when overlay is open
    expect(frame).toContain("Commands");
  });

  test("hides overlay when slashQuery is null", async () => {
    const state = buildState([{ kind: "set_slash_query", query: null }]);
    const store = createStore(state);
    const { captureCharFrame, renderOnce, renderer } = await testRender(
      () => (
        <StoreProviders store={store}>
          <ConversationView onSubmit={() => {}} onSlashDetected={() => {}} focused={true} />
        </StoreProviders>
      ),
      OPTS,
    );
    await renderOnce();
    const frame = captureCharFrame();
    renderer.destroy();
    // No SlashOverlay when slashQuery is null
    expect(frame).not.toContain("Commands");
  });
});
