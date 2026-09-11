import { describe, expect, test } from "bun:test";
import {
  commitHistory,
  createHistory,
  redoHistory,
  undoHistory,
} from "./history";

describe("edit history", () => {
  test("undoes and redoes committed edits", () => {
    const initial = createHistory("initial");
    const edited = commitHistory(initial, "edited");

    expect(undoHistory(edited).present).toBe("initial");
    expect(redoHistory(undoHistory(edited)).present).toBe("edited");
  });

  test("clears redo history after a new edit", () => {
    const history = undoHistory(commitHistory(createHistory(0), 1));
    const branched = commitHistory(history, 2);

    expect(redoHistory(branched)).toBe(branched);
  });
});
