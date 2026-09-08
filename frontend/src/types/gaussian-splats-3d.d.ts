/**
 * Minimal type declarations for @mkkellogg/gaussian-splats-3d (the package
 * ships no .d.ts). Only the surface used by GaussianSplatViewer is declared.
 */
declare module "@mkkellogg/gaussian-splats-3d" {
  export interface ViewerOptions {
    rootElement?: HTMLElement;
    threeScene?: unknown;
    cameraUp?: [number, number, number];
    initialCameraPosition?: [number, number, number];
    initialCameraLookAt?: [number, number, number];
    sharedMemoryForWorkers?: boolean;
    gpuAcceleratedSort?: boolean;
    integerBasedSort?: boolean;
    selfDrivenMode?: boolean;
    useBuiltInControls?: boolean;
  }

  export const SceneFormat: {
    Splat: number;
    KSplat: number;
    Ply: number;
    Spz: number;
  };

  export interface AddSplatSceneOptions {
    format?: number;
    showLoadingUI?: boolean;
    rotation?: [number, number, number, number];
    position?: [number, number, number];
    scale?: [number, number, number];
    splatAlphaRemovalThreshold?: number;
  }

  export class Viewer {
    constructor(options?: ViewerOptions);
    addSplatScene(path: string, options?: AddSplatSceneOptions): Promise<unknown>;
    start(): void;
    stop(): void;
    dispose(): Promise<unknown>;

    // Runtime objects owned by the viewer. `camera`/`renderer` are needed to
    // drive a custom OrbitControls; `splatMesh`/`raycaster` are needed to pick
    // an exact point on the splat surface when placing bboxes.
    camera: any;
    renderer: any;
    splatMesh: any;
    raycaster: any;
  }
}
