/**
 * Vite plugin that adds the HTTP endpoints used by 3D-BBox-Tool:
 *
 * - GET  /api/pointcloud-files     → list .pcd / .ply files under pcd/
 * - GET  /api/pcd?name=elec.pcd    → serve a binary point cloud (PCD or PLY)
 * - GET  /api/bbox?name=elec.pcd   → load saved labelled boxes for a cloud
 * - POST /api/bbox                 → persist labelled boxes (per-cloud + legacy)
 */
import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ---- helpers ----

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: any): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(json);
}

function writeJson(path: string, data: any): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function isValidFileName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.includes("..") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

// ---- Vite plugin ----

export function apiPlugin(): Plugin {
  const PROJECT_ROOT = join(import.meta.dirname, "..");
  const BBOX_DIR = join(PROJECT_ROOT, "bboxes");

  return {
    name: "3d-bbox-tool-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(
        "/api/pointcloud-files",
        async (_req: IncomingMessage, res: ServerResponse) => {
          try {
            const dir = join(PROJECT_ROOT, "pcd");
            const files = readdirSync(dir)
              .filter((f) => f.endsWith(".pcd") || f.endsWith(".ply"))
              .map((f) => ({ name: f }));
            sendJson(res, 200, { files });
          } catch (err: any) {
            sendJson(res, 500, { success: false, error: err.message });
          }
        },
      );

      server.middlewares.use(
        "/api/pcd",
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { success: false, error: "Method not allowed" });
            return;
          }
          try {
            const url = new URL(
              req.url || "",
              `http://${req.headers.host || "localhost"}`,
            );
            const name = url.searchParams.get("name");
            if (!isValidFileName(name)) {
              sendJson(res, 400, { success: false, error: "Invalid name" });
              return;
            }
            const filePath = join(PROJECT_ROOT, "pcd", name);
            const data = readFileSync(filePath);
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Length": data.length,
            });
            res.end(data);
          } catch (err: any) {
            sendJson(res, 404, { success: false, error: err.message });
          }
        },
      );

      server.middlewares.use(
        "/api/bbox",
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method === "OPTIONS") {
            res.writeHead(204, {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            });
            res.end();
            return;
          }

          // GET → load the saved bbox for a specific cloud file.
          if (req.method === "GET") {
            try {
              const url = new URL(
                req.url || "",
                `http://${req.headers.host || "localhost"}`,
              );
              const name = url.searchParams.get("name");
              if (!isValidFileName(name)) {
                sendJson(res, 400, { success: false, error: "Invalid name" });
                return;
              }
              const filePath = join(BBOX_DIR, `${name}.json`);
              const data = JSON.parse(readFileSync(filePath, "utf-8"));
              sendJson(res, 200, data);
            } catch {
              sendJson(res, 404, { success: false, error: "Not found" });
            }
            return;
          }

          if (req.method !== "POST") {
            sendJson(res, 405, { success: false, error: "Method not allowed" });
            return;
          }

          // POST → persist the labelled boxes as a per-cloud copy (for
          // auto-reload) plus the legacy six-field bbox_result.json (from the
          // first box) so downstream stays compatible.
          try {
            const body = await readBody(req);
            const payload = JSON.parse(body);
            const name = payload.name;
            if (!isValidFileName(name)) {
              sendJson(res, 400, { success: false, error: "Invalid name" });
              return;
            }

            const boxes = Array.isArray(payload.boxes) ? payload.boxes : [];

            const perCloudPath = join(BBOX_DIR, `${name}.json`);
            writeJson(perCloudPath, { name, boxes });

            const first = boxes[0];
            const legacy = first
              ? {
                  center_x: first.center_x,
                  center_y: first.center_y,
                  center_z: first.center_z,
                  size_x: first.size_x,
                  size_y: first.size_y,
                  size_z: first.size_z,
                }
              : {
                  center_x: 0,
                  center_y: 0,
                  center_z: 0,
                  size_x: 0,
                  size_y: 0,
                  size_z: 0,
                };
            writeJson(join(PROJECT_ROOT, "bbox_result.json"), legacy);

            sendJson(res, 200, { success: true, path: perCloudPath, count: boxes.length });
          } catch (err: any) {
            sendJson(res, 500, { success: false, error: err.message });
          }
        },
      );
    },
  };
}
