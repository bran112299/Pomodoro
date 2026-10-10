// Verifies records and a signed request produced by the Swift ProveCore with the TypeScript
// implementation (the reverse direction of spec/vectors). Used in CI after `swift test`.
//   npx tsx scripts/verify-swift-vectors.ts /tmp/swift-vectors.json
import { readFileSync } from "node:fs";
import { ReplayGuard, deviceIdFromPublicKey, utf8, verifyAuth, verifyRecord } from "../packages/core/src/index.js";

const file = process.argv[2];
if (!file) throw new Error("usage: verify-swift-vectors.ts <file>");
const v = JSON.parse(readFileSync(file, "utf8")) as {
  publicKey: string;
  deviceId: string;
  records: string[];
  auth: { method: string; path: string; body: string; ts: number; header: string };
};

const main = async () => {
  if ((await deviceIdFromPublicKey(v.publicKey)) !== v.deviceId) throw new Error("Swift device id doesn't match TS derivation");
  const trusted = new Map([[v.deviceId, v.publicKey]]);
  for (const raw of v.records) {
    const r = await verifyRecord(raw, trusted, v.auth.ts);
    if (!r.ok) throw new Error(`Swift record rejected by TS: ${r.reason}`);
    console.log(`ok  ${r.record.payload.typ} record from Swift verified`);
  }
  const a = await verifyAuth(v.auth.header, v.auth.method, v.auth.path, utf8(v.auth.body), trusted, new ReplayGuard(), v.auth.ts);
  if (!a.ok) throw new Error(`Swift signed request rejected by TS: ${a.reason}`);
  console.log("ok  Swift signed request verified");
};
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
