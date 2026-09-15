# 3D-ToolBox

三维 Web 编辑器，集成了三种可切换的工作模式：**3D 包围框标注**、**场景图编辑**、**三维轨迹可视化**。底层使用 React Three Fiber / Three.js 与 3D Gaussian Splatting，可在浏览器中直接渲染点云（`.pcd` / `.ply`）与高斯泼溅（`.splat` / `.ply`）资产。

## 功能

- **三种懒加载模式**：`3D-BBox Annotator`（包围框标注）、`SceneGraph Editor`（场景图编辑）、`3D-Trajectory Viewer`（轨迹查看），通过右上角按钮或 URL hash `#mode=bbox|scenegraph|traj` 切换。
- **持久 WebGL Canvas**：三个模式共用一个画布，切换模式不重新加载场景，保留高斯泼溅 GPU 资源与点云缓冲。
- **点云 / 高斯泼溅渲染**：基于 `@mkkellogg/gaussian-splats-3d`，支持 `.pcd` / `.ply` / `.splat` 等资产格式。
- **点云按高度着色**：点云支持多种配色方案（Flat / Rainbow / Cool-Warm / Grayscale / X-Ray / Y-Ray，其中 Rainbow / Cool-Warm / Grayscale 按 Z 高度着色）。
- **共享可视化参数**：三种模式共享同一套场景可视化参数——点大小、栅格尺度、坐标系显示、配色方案与不透明度，跨模式一致、跨会话持久化。
- **场景图编辑**：节点、区域（Area）、多面体（Poly）与对象（Object）的创建 / 移动 / 重命名 / 删除，以及撤销（`Ctrl/Cmd + Z`）、重做（`Ctrl/Cmd + Shift + Z` / `Ctrl/Cmd + R` / `Ctrl/Cmd + Y`）、连接（`E`）等快捷键，编辑结果可导出为新的场景图快照。
- **轨迹可视化**：只读浏览 `scenes/<scene>/trajectories/` 下的 worldmodel `flight_*` / `step_*` 目录，查看 `trajectory.json` / `prompt.json` 等结果与 `anchor.jpg` / `video.mp4` 资产。
- **内置后端 API**：Vite 插件直接在开发服务器中提供场景 / 包围框 / 场景图 / 轨迹相关 REST 接口。

## 环境要求

- [Bun](https://bun.sh/)（本仓库的规范包管理器，见 `bun.lock`）
- Node.js / Bun 运行环境
- 主要依赖：React 19、Three.js 0.170、`@react-three/fiber` 9、`@react-three/drei` 10、`@mkkellogg/gaussian-splats-3d` 0.4、Vite 6、TypeScript 5.7

## 安装

```bash
bun install
```

## 使用

启动开发服务器（默认 `http://localhost:5173`，端口被占用时自动回退）：

```bash
bun run dev
```

生产构建与预览：

```bash
bun run build
bun run preview
```

数据按场景分桶存放于 `scenes/<scene>/` 下：

```
scenes/
  diankeyuan/
    elec.ply                  # 场景点云 / 高斯泼溅资产
    bboxes/                   # 包围框标注 (<asset>.json)
    scene_graph_saved/        # 场景图快照（只读来源）
    scene_graph_exported/     # 场景图导出结果
    trajectories/             # 轨迹数据 (flight_* / step_* 目录)
```

轨迹数据放入 `scenes/<scene>/trajectories/`（`flight_*` / `step_*` 目录）后，即可在轨迹模式中浏览。

## 项目结构

```
backend/       # Vite 后端 API 插件（场景/包围框/场景图/轨迹接口）
frontend/      # React 前端（源码与构建产物 dist/）
  src/modes/bbox/         # 包围框标注模式
  src/modes/scenegraph/   # 场景图编辑模式
  src/modes/traj/         # 轨迹可视化模式
  src/shared/             # 跨模式共享组件与工具
scenes/        # 场景数据（点云 / 包围框 / 场景图快照 / 轨迹，默认 gitignore 仅保留 .gitkeep）
logs/          # 运行时日志（默认 gitignore）
bbox_result.json  # 兼容旧版的单条包围框结果（默认 gitignore）
```

## 许可证

[MIT](./LICENSE)