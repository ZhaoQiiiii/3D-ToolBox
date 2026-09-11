import { describe, expect, test } from "bun:test";
import {
  isConnectShortcut,
  isRedoShortcut,
  isUndoShortcut,
} from "./shortcuts";

describe("keyboard shortcuts", () => {
  test("recognizes E by key value", () => {
    expect(isConnectShortcut({ code: "KeyE", key: "e" })).toBe(true);
    expect(isConnectShortcut({ code: "KeyE", key: "E" })).toBe(true);
  });

  test("recognizes the physical E key during IME composition", () => {
    expect(isConnectShortcut({ code: "KeyE", key: "Process" })).toBe(true);
  });

  test("ignores other keys", () => {
    expect(isConnectShortcut({ code: "KeyG", key: "g" })).toBe(false);
  });
});

describe("history shortcuts", () => {
  const event = (code: string, overrides = {}) => ({
    code,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  test("uses Ctrl+Z for undo", () => {
    expect(isUndoShortcut(event("KeyZ"))).toBe(true);
  });

  test("uses Ctrl+R for redo instead of browser reload", () => {
    expect(isRedoShortcut(event("KeyR"))).toBe(true);
  });

  test("also supports standard redo alternatives", () => {
    expect(isRedoShortcut(event("KeyY"))).toBe(true);
    expect(isRedoShortcut(event("KeyZ", { shiftKey: true }))).toBe(true);
  });
});
