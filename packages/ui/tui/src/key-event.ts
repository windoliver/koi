/**
 * Key event predicates — pure functions for matching OpenTUI KeyEvents.
 *
 * Shared by input-keys.ts (InputArea) and keyboard.ts (global shortcuts)
 * so an OpenTUI KeyEvent shape change is a single-file fix.
 *
 * Decision 5A: centralise key-name patterns rather than inline them in every
 * handler that needs to detect the same key.
 */

import type { KeyEvent } from "@opentui/core";

export function isEscape(key: KeyEvent): boolean {
  return key.name === "escape";
}

export function isEnter(key: KeyEvent): boolean {
  return key.name === "return";
}

export function isCtrlC(key: KeyEvent): boolean {
  return key.ctrl && key.name === "c";
}

export function isCtrlP(key: KeyEvent): boolean {
  return key.ctrl && key.name === "p";
}

export function isCtrlN(key: KeyEvent): boolean {
  return key.ctrl && key.name === "n";
}

export function isCtrlJ(key: KeyEvent): boolean {
  return key.ctrl && key.name === "j";
}

export function isCtrlS(key: KeyEvent): boolean {
  return key.ctrl && key.name === "s";
}

export function isBackspace(key: KeyEvent): boolean {
  return key.name === "backspace";
}

export function isTab(key: KeyEvent): boolean {
  return key.name === "tab";
}
