import { describe, expect, test } from "bun:test";
import {
  addCreateObject,
  addCreatePoly,
  addUpdateCreateObjectColor,
  addUpdateCreateObjectLabel,
  addUpdateCreateObjectPosition,
  addUpdateCreatePolyCenter,
  emptyMutations,
  removeCreateObject,
  removeCreatePoly,
} from "./mutations";

// Pending (unexported) entries carry synthetic negative display ids:
// createPoly[k] renders as node id -(k+1), createObjects[k] as object id
// -(k+1). These tests cover the helpers that edit/delete those entries.

describe("pending createPoly helpers", () => {
  test("addUpdateCreatePolyCenter rewrites the entry's center", () => {
    let m = emptyMutations();
    m = addCreatePoly(m, 3, [1, 2, 3], 0.5);
    m = addUpdateCreatePolyCenter(m, 0, [9, 8, 7]);

    expect(m.createPoly.length).toBe(1);
    expect(m.createPoly[0]!.center).toEqual([9, 8, 7]);
    expect(m.createPoly[0]!.areaId).toBe(3);
    expect(m.createPoly[0]!.size).toBe(0.5);
  });

  test("addUpdateCreatePolyCenter ignores out-of-range indices", () => {
    let m = emptyMutations();
    m = addCreatePoly(m, 1, [0, 0, 0], 0.5);

    expect(addUpdateCreatePolyCenter(m, -1, [1, 1, 1])).toEqual(m);
    expect(addUpdateCreatePolyCenter(m, 5, [1, 1, 1])).toEqual(m);
  });

  test("removeCreatePoly drops the entry and stale movePoly references", () => {
    let m = emptyMutations();
    m = addCreatePoly(m, 1, [0, 0, 0], 0.5); // synthetic id -1
    m = addCreatePoly(m, 2, [1, 0, 0], 0.5); // synthetic id -2
    m = addMovePolySynthetic(m, -2, [5, 5, 5]);

    m = removeCreatePoly(m, 1); // remove the second entry (id -2)

    expect(m.createPoly.length).toBe(1);
    expect(m.createPoly[0]!.center).toEqual([0, 0, 0]);
    // The stale movePoly for the removed synthetic id must be gone.
    expect(m.movePoly).toHaveLength(0);
  });

  test("removeCreatePoly ignores out-of-range indices", () => {
    const m = emptyMutations();
    expect(removeCreatePoly(m, 0)).toEqual(m);
  });
});

describe("pending createObjects helpers", () => {
  test("addUpdateCreateObjectPosition/Label/Color edit the entry in place", () => {
    let m = emptyMutations();
    m = addCreateObject(m, "desk", [1, 2, 3], [10, 20, 30]);

    m = addUpdateCreateObjectPosition(m, 0, [7, 8, 9]);
    m = addUpdateCreateObjectLabel(m, 0, "chair");
    m = addUpdateCreateObjectColor(m, 0, [40, 50, 60]);

    expect(m.createObjects.length).toBe(1);
    expect(m.createObjects[0]).toEqual({
      label: "chair",
      position: [7, 8, 9],
      color: [40, 50, 60],
    });
  });

  test("update helpers ignore out-of-range indices", () => {
    let m = emptyMutations();
    m = addCreateObject(m, "desk", [0, 0, 0], [1, 1, 1]);

    expect(addUpdateCreateObjectPosition(m, 1, [1, 1, 1])).toEqual(m);
    expect(addUpdateCreateObjectLabel(m, -1, "x")).toEqual(m);
    expect(addUpdateCreateObjectColor(m, 9, [1, 1, 1])).toEqual(m);
  });

  test("removeCreateObject drops the entry", () => {
    let m = emptyMutations();
    m = addCreateObject(m, "a", [0, 0, 0], [1, 1, 1]);
    m = addCreateObject(m, "b", [1, 1, 1], [2, 2, 2]);

    m = removeCreateObject(m, 0);

    expect(m.createObjects.length).toBe(1);
    expect(m.createObjects[0]!.label).toBe("b");
  });

  test("removeCreateObject remaps later synthetic ids in objectOrder", () => {
    let m = emptyMutations();
    m = addCreateObject(m, "a", [0, 0, 0], [1, 1, 1]); // synthetic id -1
    m = addCreateObject(m, "b", [1, 1, 1], [2, 2, 2]); // synthetic id -2
    m = addCreateObject(m, "c", [2, 2, 2], [3, 3, 3]); // synthetic id -3
    m = { ...m, objectOrder: [-1, 5, -3, -2] };

    m = removeCreateObject(m, 0); // remove "a" (id -1)

    // Entries after index 0 shift up: -2 → -1, -3 → -2; -1 itself is dropped.
    expect(m.objectOrder).toEqual([5, -2, -1]);
  });

  test("removeCreateObject with a real id in objectOrder keeps it untouched", () => {
    let m = emptyMutations();
    m = addCreateObject(m, "a", [0, 0, 0], [1, 1, 1]); // synthetic id -1
    m = { ...m, objectOrder: [7, -1] };

    m = removeCreateObject(m, 0);

    expect(m.objectOrder).toEqual([7]);
  });

  test("removeCreateObject ignores out-of-range indices", () => {
    const m = emptyMutations();
    expect(removeCreateObject(m, 0)).toEqual(m);
  });
});

// Build a movePoly entry pointing at a synthetic negative id directly (the
// component never creates these through addMovePoly, but removeCreatePoly
// defensively cleans them up).
function addMovePolySynthetic(
  m: ReturnType<typeof emptyMutations>,
  id: number,
  center: [number, number, number],
) {
  return { ...m, movePoly: [...m.movePoly, { id, center }] };
}
