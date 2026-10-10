// Bundles the Electron main process, preload and renderer pages with esbuild.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, "dist");
const prod = process.env.NODE_ENV !== "development";

rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, "renderer"), { recursive: true });

const common = { bundle: true, sourcemap: prod ? false : "inline", minify: prod, logLevel: "info", legalComments: "none" };

await build({
  ...common,
  entryPoints: { main: path.join(here, "src/main/main.ts") },
  outdir: path.join(dist, "main"),
  outExtension: { ".js": ".cjs" },
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
});

await build({
  ...common,
  entryPoints: { preload: path.join(here, "src/preload/preload.ts") },
  outdir: path.join(dist, "preload"),
  outExtension: { ".js": ".cjs" },
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
});

await build({
  ...common,
  entryPoints: { dashboard: path.join(here, "src/renderer/dashboard.tsx"), lock: path.join(here, "src/renderer/lock.tsx") },
  outdir: path.join(dist, "renderer"),
  platform: "browser",
  format: "iife",
  target: "chrome120",
  jsx: "automatic",
  jsxImportSource: "preact",
  loader: { ".json": "json" },
  define: { "process.env.NODE_ENV": JSON.stringify(prod ? "production" : "development") },
});

for (const f of ["index.html", "lock.html"]) copyFileSync(path.join(here, "src/renderer", f), path.join(dist, "renderer", f));
// sql.js WebAssembly for Anki imports in the main process.
copyFileSync(path.join(path.dirname(require.resolve("sql.js")), "sql-wasm.wasm"), path.join(dist, "main", "sql-wasm.wasm"));
console.log("desktop build complete");
