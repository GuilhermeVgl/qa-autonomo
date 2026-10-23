import { createHmac } from "node:crypto";

/** RFC 4648 base32 alphabet, used by every authenticator app for the shared secret. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decodes a base32 secret as authenticator apps store it: case-insensitive, spaces and padding ignored. */
export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32 character in TOTP secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/**
 * The 6-digit TOTP code for a shared secret (RFC 6238, SHA-1, 30s step): the same algorithm every authenticator app uses,
 * so it works with any provider without provider-specific code. `atMs` is injectable for tests.
 */
export function totpCode(secret: string, atMs: number = Date.now(), step = 30, digits = 6): string {
  const key = base32Decode(secret);
  const counter = Math.floor(atMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac.readUInt8(hmac.length - 1) & 0x0f;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff; // RFC 6238 dynamic truncation: 4 bytes, top bit cleared
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}
