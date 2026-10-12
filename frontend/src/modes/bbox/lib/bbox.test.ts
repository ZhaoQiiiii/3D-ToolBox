import { describe, expect, test } from "bun:test";
import {
  formatBboxPresets,
  parseBoxes,
  toBBoxOutput,
  type BBoxItem,
} from "./bbox";

describe("bbox association fields", () => {
  test("parseBoxes keeps object_id/object_label on round-trip", () => {
    const payload = {
      name: "test.ply",
      boxes: [
        {
          id: "bbox_a",
          label: "object_3",
          min: [1, 2, 3],
          max: [4, 5, 6],
          object_id: 24,
          object_label: "Anchen 1553 Line Surge Arrester",
        },
        {
          id: "bbox_b",
          label: "object_4",
          min: [0, 0, 0],
          max: [1, 1, 1],
        },
      ],
    };

    const parsed = parseBoxes(payload);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.objectId).toBe(24);
    expect(parsed[0]!.objectLabel).toBe("Anchen 1553 Line Surge Arrester");
    // Missing fields default to null (backward compatible with old files).
    expect(parsed[1]!.objectId).toBeNull();
    expect(parsed[1]!.objectLabel).toBeNull();

    // toBBoxOutput must serialize both fields so the BBox Anno auto-save
    // (whole-file overwrite) never drops an association.
    const outputs = parsed.map(toBBoxOutput);
    expect(outputs[0]!.object_id).toBe(24);
    expect(outputs[0]!.object_label).toBe("Anchen 1553 Line Surge Arrester");
    expect(outputs[1]!.object_id).toBeNull();
    expect(outputs[1]!.object_label).toBeNull();
    // The six legacy numeric fields stay intact for isValidBoxes.
    expect(outputs[0]!.center_x).toBe(2.5);
    expect(outputs[0]!.size_x).toBe(3);
  });

  test("formatBboxPresets keys associated boxes by object id with a comment", () => {
    const boxes: BBoxItem[] = [
      {
        id: "bbox_a",
        label: "object_3",
        min: [1, 2, 3],
        max: [4, 5, 6],
        objectId: 24,
        objectLabel: "Anchen 1553 Line Surge Arrester",
      },
      {
        id: "bbox_b",
        label: "object_4",
        min: [0, 0, 0],
        max: [1, 1, 1],
        objectId: null,
        objectLabel: null,
      },
    ];

    const out = formatBboxPresets(boxes);
    const lines = out.split("\n");
    expect(lines[0]).toBe("BBOX_PRESETS = {");
    expect(lines[1]).toBe(
      '    24: {"center_x": 2.500, "center_y": 3.500, "center_z": 4.500, ' +
        '"size_x": 3.000, "size_y": 3.000, "size_z": 3.000},  # Anchen 1553 Line Surge Arrester',
    );
    // Unassociated boxes keep the label-derived key and no comment.
    expect(lines[2]).toBe(
      '    4: {"center_x": 0.500, "center_y": 0.500, "center_z": 0.500, ' +
        '"size_x": 1.000, "size_y": 1.000, "size_z": 1.000},',
    );
    expect(lines[3]).toBe("}");
  });

  test("formatBboxPresets never emits duplicate keys (associated id vs label number)", () => {
    const boxes: BBoxItem[] = [
      { id: "bbox_a", label: "object_1", min: [0, 0, 0], max: [1, 1, 1], objectId: 3, objectLabel: "A" },
      { id: "bbox_b", label: "object_3", min: [0, 0, 0], max: [2, 2, 2] },
    ];
    const out = formatBboxPresets(boxes);
    const keys = [...out.matchAll(/^\s+(\d+):/gm)].map((m) => Number(m[1]));
    expect(keys).toEqual([3, 4]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("formatBboxPresets output is unchanged for boxes without associations", () => {
    const boxes: BBoxItem[] = [
      { id: "bbox_a", label: "object_3", min: [1, 2, 3], max: [4, 5, 6] },
      { id: "bbox_b", label: "box", min: [0, 0, 0], max: [1, 1, 1] },
    ];
    const out = formatBboxPresets(boxes);
    const lines = out.split("\n");
    expect(lines[1]).toBe(
      '    3: {"center_x": 2.500, "center_y": 3.500, "center_z": 4.500, ' +
        '"size_x": 3.000, "size_y": 3.000, "size_z": 3.000},',
    );
    // No "object_N" label → falls back to the list index.
    expect(lines[2]).toBe(
      '    1: {"center_x": 0.500, "center_y": 0.500, "center_z": 0.500, ' +
        '"size_x": 1.000, "size_y": 1.000, "size_z": 1.000},',
    );
    expect(out).not.toContain("#");
  });
});
