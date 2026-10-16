# 3D-ToolBox

三维 Web 编辑器，集成了三种可切换的工作模式：**3D 包围框标注**、**场景图编辑**、**三维轨迹可视化**。底层使用 React Three Fiber / Three.js 与 3D Gaussian Splatting，可在浏览器中直接渲染点云（`.pcd` / `.ply`）与高斯泼溅（`.splat` / `.ply`）资产。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## 📜 简介

3D-ToolBox 把三种彼此独立却又共用同一套场景资产的工作流整合进一个浏览器应用：标注包围框、编辑场景图、回看飞行轨迹。三种模式都挂载在 App 层唯一的持久 WebGL `<Canvas>` 上，因此切换模式不会重建场景，高斯泼溅纹理与点云 GPU 缓冲得以保留；相机位姿以及点大小、栅格、坐标轴、配色等可视化参数在模式之间共享并跨会话记忆。应用没有独立后端进程——场景 / 包围框 / 场景图 / 轨迹的 REST 接口由 Vite 开发服务器的内置插件提供，数据按 `scenes/<scene>/` 分桶存放。

## 功能

- **三种懒加载模式**：`3D-BBox Annotator`（包围框标注）、`SceneGraph Editor`（场景图编辑）、`3D-Trajectory Viewer`（轨迹查看），通过右上角按钮或 URL hash `#mode=bbox|scenegraph|traj` 切换。
- **持久 WebGL Canvas**：三个模式共用一个画布，切换模式不重新加载场景，保留高斯泼溅 GPU 资源与点云缓冲。
- **点云 / 高斯泼溅渲染**：基于 `@mkkellogg/gaussian-splats-3d`，支持 `.pcd` / `.ply` / `.splat` 等资产格式。
- **点云按高度着色**：点云支持多种配色方案（Flat / Rainbow / Cool-Warm / Grayscale / X-Ray / Y-Ray，其中 Rainbow / Cool-Warm / Grayscale 按 Z 高度着色）。
- **共享可视化参数**：三种模式共享同一套场景可视化参数——点大小、栅格尺度、坐标系显示、配色方案与不透明度，跨模式一致、跨会话持久化。
- **场景图编辑**：节点、区域（Area）、多面体（Poly）与对象（Object）的创建 / 移动 / 重命名 / 删除，以及撤销（`Ctrl/Cmd + Z`）、重做（`Ctrl/Cmd + Shift + Z` / `Ctrl/Cmd + R` / `Ctrl/Cmd + Y`）、连接（`E`）等快捷键，编辑结果可导出为新的场景图快照。
- **轨迹可视化**：只读浏览 `scenes/<scene>/trajectories/` 下的 worldmodel `flight_*` / `step_*` 目录，查看 `trajectory.json` / `prompt.json` 等结果与 `anchor.jpg` / `video.mp4` 资产。
- **内置后端 API**：Vite 插件直接在开发服务器中提供场景 / 包围框 / 场景图 / 轨迹相关 REST 接口。

## 📋 环境要求

- Bun（本仓库的规范包管理器与测试运行器，见 `bun.lock`）
- 主要依赖（版本取自 `package.json`）：`react ^19.0.0`、`three ^0.170.0`、`@react-three/fiber ^9.0.0`、`@react-three/drei ^10.0.0`、`@mkkellogg/gaussian-splats-3d ^0.4.7`、`vite ^6.0.0`、`typescript ^5.7.0`

## 📦 安装

```bash
bun install
```

## 🚀 使用

| Name | Purpose | Example |
|---|---|---|
| `bun run dev` | 启动 Vite 开发服务器与内置后端 API（默认 `http://localhost:5173`，端口占用时自动回退） | `bun run dev` |
| `bun run build` | 类型检查并构建生产产物到 `frontend/dist/` | `bun run build` |
| `bun run preview` | 预览已构建的产物 | `bun run preview` |
| `bunx tsc -p frontend --noEmit` | 仅类型检查（tsconfig 位于 `frontend/`） | `bunx tsc -p frontend --noEmit` |
| `bun test` | 运行 `bun:test` 测试 | `bun test` |

场景数据按场景分桶存放于 `scenes/<scene>/` 下；把轨迹数据放入 `scenes/<scene>/trajectories/`（`flight_*` / `step_*` 目录）后，即可在轨迹模式中浏览。

## 📁 项目结构

```
backend/            # Vite 后端 API 插件（场景 / 包围框 / 场景图 / 轨迹接口）
  api-plugin.ts     # 单文件路由实现
frontend/           # React 前端（Vite root；构建产物在 dist/）
  index.html
  tsconfig.json
  src/
    App.tsx         # App 层唯一的持久 WebGL <Canvas> 与模式切换
    main.tsx        # 入口
    modes/          # 三种模式：bbox / scenegraph / traj
    shared/         # 跨模式共享组件、hook 与工具
scenes/             # 场景数据桶（默认 gitignore，仅保留 .gitkeep）
  <scene>/
    bboxes/                # 包围框标注 (<asset>.json)
    scene_graph_saved/     # 场景图快照（只读来源）
    scene_graph_exported/  # 场景图导出结果
    trajectories/          # 轨迹数据 (flight_* / step_* 目录)
logs/               # 运行时日志（默认 gitignore）
plans/              # 设计 / 方案文档（默认 gitignore）
```
