// Minimal protobuf wire-format reader, enough to pull strings/ints out of the config blobs that
// modern Anki (schema 18+) stores in its notetypes/templates tables and media manifest.

export type ProtoValue = { wire: 0; value: bigint } | { wire: 2; value: Uint8Array } | { wire: 1 | 5; value: Uint8Array };

export function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error("truncated varint");
    const b = buf[pos++]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  throw new Error("varint too long");
}

/** Decode one message level into field number -> values (in order). */
export function decodeMessage(buf: Uint8Array): Map<number, ProtoValue[]> {
  const fields = new Map<number, ProtoValue[]>();
  let pos = 0;
  while (pos < buf.length) {
    const [key, p1] = readVarint(buf, pos);
    pos = p1;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let v: ProtoValue;
    switch (wire) {
      case 0: {
        const [val, p2] = readVarint(buf, pos);
        pos = p2;
        v = { wire: 0, value: val };
        break;
      }
      case 1:
        if (pos + 8 > buf.length) throw new Error("truncated fixed64");
        v = { wire: 1, value: buf.subarray(pos, pos + 8) };
        pos += 8;
        break;
      case 2: {
        const [len, p2] = readVarint(buf, pos);
        const n = Number(len);
        if (p2 + n > buf.length) throw new Error("truncated length-delimited field");
        v = { wire: 2, value: buf.subarray(p2, p2 + n) };
        pos = p2 + n;
        break;
      }
      case 5:
        if (pos + 4 > buf.length) throw new Error("truncated fixed32");
        v = { wire: 5, value: buf.subarray(pos, pos + 4) };
        pos += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${wire}`);
    }
    const list = fields.get(field) ?? [];
    list.push(v);
    fields.set(field, list);
  }
  return fields;
}

export function getString(msg: Map<number, ProtoValue[]>, field: number): string | undefined {
  const v = msg.get(field)?.[0];
  return v && v.wire === 2 ? new TextDecoder().decode(v.value) : undefined;
}

export function getInt(msg: Map<number, ProtoValue[]>, field: number): number | undefined {
  const v = msg.get(field)?.[0];
  return v && v.wire === 0 ? Number(v.value) : undefined;
}

export function getMessages(msg: Map<number, ProtoValue[]>, field: number): Map<number, ProtoValue[]>[] {
  return (msg.get(field) ?? []).filter((v) => v.wire === 2).map((v) => decodeMessage(v.value as Uint8Array));
}
