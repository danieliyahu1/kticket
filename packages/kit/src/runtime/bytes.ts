// Little-endian byte encoding + concatenation helpers, shared by the v1
// transaction serialization (serialize.ts) and the covenant-id hashing
// (covenant.ts).

const U16_LENGTH = 2;
const U32_LENGTH = 4;
const U64_LENGTH = 8;

function le16(value: number): Uint8Array {
  const out = new Uint8Array(U16_LENGTH);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function le32(value: number): Uint8Array {
  const out = new Uint8Array(U32_LENGTH);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function le64(value: number): Uint8Array {
  const out = new Uint8Array(U64_LENGTH);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export { concat, le16, le32, le64 };
