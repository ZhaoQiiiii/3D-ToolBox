# AGENTS.md — 3D-ToolBox

3D web editor combining three switchable modes (3D bbox annotation, scene-graph
editing, trajectory visualization) on React Three Fiber / Three.js + 3DGS. This
repo has its own history; the parent workspace and its `AGENTS.md` are separate.

## Commands

Canonical package manager is **Bun** (`bun.lock`). `package-lock.json` is a
stale, gitignored artifact — ignore it.

```bash
bun install
bun run dev                       # Vite dev server + built-in backend API, :5173 (falls back if busy)
bun run build                     # tsc -p frontend && vite build  (tsconfig is at frontend/, NOT root)
bun run preview
bunx tsc -p frontend --noEmit     # typecheck only
bun test                          # bun:test; there is NO npm "test" script
bun test frontend/src/modes/bbox/lib/bbox.test.ts   # single file
bun test -t "describe or test name"                 # single test
```

No ESLint / Prettier / pre-commit / CI is configured. `tsconfig` does **not**
set `noUnusedLocals`, so unused imports will not fail the build — clean them up
manually.

## Architecture (non-obvious)

- **One persistent WebGL `<Canvas>` at `frontend/src/App.tsx`**, never per-mode.
  Modes are lazily-loaded DOM subtrees that push 3D content into the shared
  canvas through `useCanvasSlot` (`shared/canvas-slot.tsx`). Unmounting a
  `Canvas` force-loses the WebGL context and destroys 3DGS textures / point-cloud
  GPU buffers — do **not** add a second `<Canvas>` or call R3F hooks from the DOM
  side.
- Shared cross-mode state lives in `shared/`: `use-scene-camera` (one camera
  pose across modes), `use-scene-visuals` (point size / grid / axes / color
  scheme), `fly-camera-controllers` (wheel=fly, left-drag=FPS look in all modes;
  OrbitControls' own rotate/zoom are disabled). Entry point is `main.tsx` → `App`.
- **Backend is a Vite dev-server plugin** (`backend/api-plugin.ts`), not a
  standalone process. REST routes (`/api/scenes`, `/api/pcd`, `/api/bbox`,
  `/api/scene-graph`, `/api/snapshots`, `/api/export`, `/api/traj-*`, `/api/log`)
  only exist under `bun run dev`/`preview`. `vite build` emits a static SPA with
  **no** API — don't expect the built `dist/` to serve data.
- Data lives under `scenes/<scene>/`: `bboxes/<asset>.json`,
  `scene_graph_saved/<snapshot>/`, `scene_graph_exported/<snapshot>/`,
  `trajectories/`. Gitignored except `.gitkeep`; never commit scene/log data.

## Gotchas

- 3D content is wrapped in a `rotation={[-Math.PI/2,0,0]}` group (source data is
  Z-up → three.js Y-up). Keep new meshes inside that group or they'll be misaligned.
- localStorage prefixes are byte-stable and cross-mode: `3dbbox_` (bbox visuals +
  `3dbbox_appMode`), `sge_` (scenegraph display), `scene_` (camera/visuals).
  Renaming a prefix silently resets every saved user setting. `3dbbox_lineWidth` /
  `3dbbox_opacity` are deliberately shared by the BBox mode and the SceneGraph
  overlay.
- POST `/api/bbox` is a **whole-file overwrite**; `isValidBoxes` validates only
  the six numeric fields, so extra fields (`object_id`/`object_label`) pass
  through. BBox Anno auto-saves the whole file, so `parseBoxes`/`toBBoxOutput`
  must round-trip any field or it is lost on the next edit.
- SceneGraph pending (unexported) edits: new **nodes** carry pre-assigned real
  poly ids (`nextPolyId`, honored by backend `applyCreatePolys`); new **objects**
  still use synthetic negative ids `-(index+1)`. `applyMutations` order is
  load-bearing: deletes → moves → **createPoly before addEdges** (edges to new
  polys must resolve) → createObjects → **updateObjectIds before all other
  object mutations** (renames rewrite the rest) → father_polys.
- React `StrictMode` is on: state updaters must be pure, and do not create
  disposable `THREE` resources inside `useMemo` factories (double-invoked).
- Comments and UI text mix English and Chinese; keep code/commands ASCII.

## Conventions

- Commit messages: emoji-prefixed Conventional Commits, lowercase imperative
  (`✨ feat:`, `♻️ refactor:`, `🔧 chore:`).
- Never commit secrets; use env vars. Never commit `scenes/`, `logs/`,
  `bbox_result.json`, `.trae/`, or `frontend/dist/`.
- Run `git` from inside this directory only (the parent workspace is not a repo).
