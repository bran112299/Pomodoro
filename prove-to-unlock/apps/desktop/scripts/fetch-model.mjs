// Downloads the MobileNet v2 TF.js graph model into assets/models so the app can label photos
// fully offline. Run once before packaging (CI does this automatically).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://storage.googleapis.com/tfjs-models/savedmodel/mobilenet_v2_1.0_224/";
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "models", "mobilenet_v2");
mkdirSync(out, { recursive: true });

async function get(name, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(BASE + name);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= attempts) throw new Error(`downloading ${name}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (i - 1)));
    }
  }
}

const modelPath = path.join(out, "model.json");
const model = existsSync(modelPath) ? readFileSync(modelPath) : await get("model.json");
writeFileSync(modelPath, model);
const manifest = JSON.parse(model.toString("utf8")).weightsManifest;
let total = 0;
for (const group of manifest) {
  for (const p of group.paths) {
    const file = path.join(out, p);
    if (existsSync(file)) {
      total += readFileSync(file).length;
      continue;
    }
    const buf = await get(p);
    writeFileSync(file, buf);
    total += buf.length;
    console.log(`  ${p} ${(buf.length / 1e6).toFixed(1)} MB sha256 ${createHash("sha256").update(buf).digest("hex").slice(0, 12)}`);
  }
}
console.log(`MobileNet v2 ready in ${out} (${(total / 1e6).toFixed(1)} MB)`);
