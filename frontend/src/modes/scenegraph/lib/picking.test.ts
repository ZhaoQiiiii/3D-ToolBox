import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { pickTarget, projectLocalPoint } from "./picking";
import type { TopologicalEdge, TopologicalNode } from "./types";

const WIDTH = 800;
const HEIGHT = 800;

function camera(): THREE.PerspectiveCamera {
  const result = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  result.position.set(0, 0, 10);
  result.lookAt(0, 0, 0);
  result.updateMatrixWorld();
  result.updateProjectionMatrix();
  return result;
}

function node(id: number, position: [number, number, number]): TopologicalNode {
  return { id, areaId: 1, position, colorHex: "#ffffff" };
}

function edge(
  srcId: number,
  dstId: number,
  srcPos: [number, number, number],
  dstPos: [number, number, number],
): TopologicalEdge {
  return {
    srcId,
    dstId,
    srcPos,
    dstPos,
    length: new THREE.Vector3(...srcPos).distanceTo(new THREE.Vector3(...dstPos)),
    srcColorHex: "#ffffff",
    dstColorHex: "#ffffff",
    crossArea: false,
  };
}

describe("screen-space picking", () => {
  test("projects through the scene group's rotation", () => {
    const rotated = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    const point = projectLocalPoint([0, 0, 2], rotated, camera(), WIDTH, HEIGHT);

    expect(point).not.toBeNull();
    expect(point!.x).toBeCloseTo(WIDTH / 2);
    expect(point!.y).toBeLessThan(HEIGHT / 2);
  });

  test("picks the nearest node inside a stable pixel radius", () => {
    const cam = camera();
    const matrix = new THREE.Matrix4();
    const nodes = [node(1, [-1, 0, 0]), node(2, [1, 0, 0])];
    const point = projectLocalPoint(nodes[1].position, matrix, cam, WIDTH, HEIGHT)!;

    expect(
      pickTarget({
        nodes,
        edges: [],
        camera: cam,
        sceneMatrixWorld: matrix,
        width: WIDTH,
        height: HEIGHT,
        pointerX: point.x + 4,
        pointerY: point.y,
      }),
    ).toEqual({ kind: "node", id: 2 });
  });

  test("picks an edge near its projected segment", () => {
    const cam = camera();
    const matrix = new THREE.Matrix4();

    expect(
      pickTarget({
        nodes: [],
        edges: [edge(8, 3, [-2, 0, 0], [2, 0, 0])],
        camera: cam,
        sceneMatrixWorld: matrix,
        width: WIDTH,
        height: HEIGHT,
        pointerX: WIDTH / 2,
        pointerY: HEIGHT / 2 + 5,
      }),
    ).toEqual({ kind: "edge", key: "3_8" });
  });

  test("prefers a node when node and edge scores are equal", () => {
    const cam = camera();
    const matrix = new THREE.Matrix4();

    expect(
      pickTarget({
        nodes: [node(4, [0, 0, 0])],
        edges: [edge(4, 5, [0, 0, 0], [2, 0, 0])],
        camera: cam,
        sceneMatrixWorld: matrix,
        width: WIDTH,
        height: HEIGHT,
        pointerX: WIDTH / 2,
        pointerY: HEIGHT / 2,
      }),
    ).toEqual({ kind: "node", id: 4 });
  });

  test("ignores targets outside the radius or behind the camera", () => {
    const cam = camera();
    const matrix = new THREE.Matrix4();

    expect(
      pickTarget({
        nodes: [node(1, [0, 0, 0]), node(2, [0, 0, 11])],
        edges: [],
        camera: cam,
        sceneMatrixWorld: matrix,
        width: WIDTH,
        height: HEIGHT,
        pointerX: WIDTH / 2 + 20,
        pointerY: HEIGHT / 2,
      }),
    ).toBeNull();
    expect(projectLocalPoint([0, 0, 11], matrix, cam, WIDTH, HEIGHT)).toBeNull();
  });
});
