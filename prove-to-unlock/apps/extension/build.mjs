// Builds the extension for Chrome/Edge/Brave (dist/chrome) and Firefox (dist/firefox), and zips
// each one (dist/prove-to-unlock-<browser>.zip) ready to load or upload.
import { build } from "esbuild";
import { zipSync } from "fflate";
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = path.join(here, "dist");
const version = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")).version;

rmSync(dist, { recursive: true, force: true });
const out = path.join(dist, "common");
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    background: path.join(here, "src/background.ts"),
    lock: path.join(here, "src/lock.tsx"),
    options: path.join(here, "src/options.tsx"),
    popup: path.join(here, "src/popup.tsx"),
  },
  outdir: out,
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120", "firefox121"],
  jsx: "automatic",
  jsxImportSource: "preact",
  legalComments: "none",
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"' },
  // sql.js references node builtins behind runtime checks; they're never used in the browser.
  external: ["fs", "path", "crypto"],
});

const page = (title, script) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="./${script}.css" />
  </head>
  <body>
    <div id="app"></div>
    <script src="./${script}.js"></script>
  </body>
</html>
`;
writeFileSync(path.join(out, "lock.html"), page("Blocked: prove to unlock", "lock"));
writeFileSync(path.join(out, "options.html"), page("Prove to Unlock settings", "options"));
writeFileSync(path.join(out, "popup.html"), page("Prove to Unlock", "popup"));
copyFileSync(path.join(path.dirname(require.resolve("sql.js")), "sql-wasm.wasm"), path.join(out, "sql-wasm.wasm"));
cpSync(path.join(here, "static"), out, { recursive: true });

const base = {
  manifest_version: 3,
  name: "Prove to Unlock",
  version,
  description: "Blocks distracting sites until you prove you did what you committed to (gym, Anki, focus). Works with the Prove to Unlock apps.",
  icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
  permissions: ["storage", "unlimitedStorage", "alarms", "declarativeNetRequest", "tabs"],
  host_permissions: ["<all_urls>"],
  action: { default_popup: "popup.html", default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" } },
  options_ui: { page: "options.html", open_in_tab: true },
  web_accessible_resources: [{ resources: ["lock.html"], matches: ["<all_urls>"] }],
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
};

const manifests = {
  chrome: { ...base, background: { service_worker: "background.js" }, minimum_chrome_version: "120" },
  firefox: {
    ...base,
    background: { scripts: ["background.js"] },
    browser_specific_settings: { gecko: { id: "prove-to-unlock@provetounlock.app", strict_min_version: "121.0", data_collection_permissions: { required: ["none"] } } },
  },
};

function walk(dir, prefix = "") {
  const files = {};
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(p).isDirectory()) Object.assign(files, walk(p, rel));
    else files[rel] = new Uint8Array(readFileSync(p));
  }
  return files;
}

for (const [browser, manifest] of Object.entries(manifests)) {
  const dir = path.join(dist, browser);
  cpSync(out, dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(dist, `prove-to-unlock-${browser}-${version}.zip`), zipSync(walk(dir), { level: 9 }));
  console.log(`built ${browser}: dist/${browser}  +  dist/prove-to-unlock-${browser}-${version}.zip`);
}
rmSync(out, { recursive: true, force: true });
