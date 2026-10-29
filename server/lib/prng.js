/** PRNG xác định (ADR-0006): xmur3 làm hạt giống + mulberry32. Cùng seed → cùng chuỗi trên mọi nền tảng (số nguyên 32-bit). */
export function seedFrom(x) {
  let h = 1779033703 ^ String(x).length;
  for (const c of String(x)) { h = Math.imul(h ^ c.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}
export function mulberry32(seed) {
  let a = seedFrom(seed);
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffle(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export const PRNG_NAME = 'xmur3+mulberry32/v1';
