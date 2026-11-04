/** IEEE 754 half-precision packing for the backup format (ADR-0028); no dependency on Float16Array. */

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const rawExp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (rawExp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const exp = rawExp - 127 + 15;
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let half = mant >>> shift;
    const rest = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rest > halfway || (rest === halfway && (half & 1))) half++;
    return sign | half;
  }
  let half = sign | (exp << 10) | (mant >>> 13);
  const rest = mant & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (half & 1))) half++;
  return half;
}

function fromHalf(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exp = (half >>> 10) & 0x1f;
  const mant = half & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/** Base64 of the vector as little-endian float16 values (2 bytes per dimension). */
export function encodeVector16(vector: readonly number[]): string {
  const bytes = Buffer.alloc(vector.length * 2);
  vector.forEach((v, i) => bytes.writeUInt16LE(toHalf(v), i * 2));
  return bytes.toString("base64");
}

export function decodeVector16(encoded: string): number[] {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length % 2 !== 0) throw new Error("float16 vector has an odd byte length");
  const out: number[] = new Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = fromHalf(bytes.readUInt16LE(i * 2));
  return out;
}
