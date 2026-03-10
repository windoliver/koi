/**
 * DOM environment preload — sets up happy-dom globals BEFORE any test imports.
 *
 * This runs via bunfig.toml preload so that @testing-library/react finds
 * document.body when its `screen` module is first evaluated.
 */

import { Window } from "happy-dom";

const window = new Window();
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  HTMLElement: window.HTMLElement,
  HTMLDivElement: window.HTMLDivElement,
  HTMLSpanElement: window.HTMLSpanElement,
  HTMLParagraphElement: window.HTMLParagraphElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  MutationObserver: window.MutationObserver,
  CustomEvent: window.CustomEvent,
  KeyboardEvent: window.KeyboardEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
});
