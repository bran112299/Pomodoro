// Device identity and signatures.
//
// Every device has an ECDSA P-256 key pair. The public key is exchanged as SPKI DER (base64),
// signatures are raw r||s (IEEE P1363, 64 bytes) over SHA-256. This is exactly what Apple
// CryptoKit produces (`P256.Signing.PublicKey.derRepresentation`, `ECDSASignature.rawRepresentation`),
// so iOS (Secure Enclave) and WebCrypto interoperate without conversion.

import { b64ToBytes, bytesToB64, bytesToHex, bytesToB64url } from "./b64.js";

const ALG: EcKeyImportParams = { name: "ECDSA", namedCurve: "P-256" };
const SIGN_ALG: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto (crypto.subtle) is not available in this environment");
  return c.subtle;
}

// WebCrypto's BufferSource typing is strict about ArrayBuffer vs SharedArrayBuffer; all our
// buffers are plain ArrayBuffers.
function buf(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export interface Identity {
  deviceId: string;
  /** SPKI DER, base64 */
  publicKey: string;
  privateKey: CryptoKey;
}

export interface StoredIdentity {
  publicKey: string;
  privateJwk: JsonWebKey;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", buf(data)));
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function randomId(nBytes = 16): string {
  return bytesToB64url(randomBytes(nBytes));
}

/** Device id = first 8 bytes of SHA-256(SPKI), hex. Derived from the key so it can't be spoofed. */
export async function deviceIdFromPublicKey(spkiB64: string): Promise<string> {
  const h = await sha256(b64ToBytes(spkiB64));
  return bytesToHex(h.subarray(0, 8));
}

/** Human-comparable fingerprint shown during pairing, e.g. "3F9A-12CD-77B0-E415". */
export async function fingerprint(spkiB64: string): Promise<string> {
  const h = bytesToHex((await sha256(b64ToBytes(spkiB64))).subarray(0, 8)).toUpperCase();
  return h.match(/.{4}/g)!.join("-");
}

export async function generateIdentity(): Promise<Identity> {
  const pair = (await subtle().generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
  const publicKey = bytesToB64(spki);
  return { deviceId: await deviceIdFromPublicKey(publicKey), publicKey, privateKey: pair.privateKey };
}

export async function exportIdentity(id: Identity): Promise<StoredIdentity> {
  const privateJwk = await subtle().exportKey("jwk", id.privateKey);
  return { publicKey: id.publicKey, privateJwk };
}

export async function importIdentity(stored: StoredIdentity): Promise<Identity> {
  const privateKey = await subtle().importKey("jwk", stored.privateJwk, ALG, true, ["sign"]);
  return { deviceId: await deviceIdFromPublicKey(stored.publicKey), publicKey: stored.publicKey, privateKey };
}

const pubKeyCache = new Map<string, Promise<CryptoKey>>();

export function importPublicKey(spkiB64: string): Promise<CryptoKey> {
  let p = pubKeyCache.get(spkiB64);
  if (!p) {
    p = subtle().importKey("spki", buf(b64ToBytes(spkiB64)), ALG, false, ["verify"]);
    p.catch(() => pubKeyCache.delete(spkiB64));
    pubKeyCache.set(spkiB64, p);
  }
  return p;
}

export async function sign(id: Identity, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign(SIGN_ALG, id.privateKey, buf(data)));
}

export async function verify(spkiB64: string, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  if (signature.length !== 64) return false;
  try {
    const key = await importPublicKey(spkiB64);
    return await subtle().verify(SIGN_ALG, key, buf(signature), buf(data));
  } catch {
    return false;
  }
}
