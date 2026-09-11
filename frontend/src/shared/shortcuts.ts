export function isConnectShortcut(
  event: Pick<KeyboardEvent, "code" | "key">,
): boolean {
  return event.code === "KeyE" || event.key.toLowerCase() === "e";
}

type HistoryShortcutEvent = Pick<
  KeyboardEvent,
  "code" | "ctrlKey" | "metaKey" | "shiftKey"
>;

export function isUndoShortcut(event: HistoryShortcutEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.code === "KeyZ" && !event.shiftKey;
}

export function isRedoShortcut(event: HistoryShortcutEvent): boolean {
  if (!(event.ctrlKey || event.metaKey)) return false;
  return (
    event.code === "KeyR" ||
    event.code === "KeyY" ||
    (event.code === "KeyZ" && event.shiftKey)
  );
}
