// ============================================================
// noise.js —— 完全自实现的噪声工具
//  - mulberry32：种子随机数
//  - makePermutation：由种子派生 Perlin 置换表
//  - PerlinNoise2D：经典二维 Perlin（fractal 渐变噪声）
//  - fbm2 / ridge2：分形叠加
// 本文件不依赖任何第三方噪声库。
// ============================================================

/** 可重复的种子随机数生成器（mulberry32） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串 → 32 位整数种子（FNV-1a） */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fade(t) {
  // 6t^5 - 15t^4 + 10t^3
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 由种子生成 Perlin 置换表（0..255 的洗牌，双份） */
function makePermutation(rng) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // Fisher-Yates 洗牌
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

// 8 种二维梯度方向
const GRAD2 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.70710678, 0.70710678], [-0.70710678, 0.70710678],
  [0.70710678, -0.70710678], [-0.70710678, -0.70710678],
];

function grad(hash, x, y) {
  const g = GRAD2[hash & 7];
  return g[0] * x + g[1] * y;
}

/** 经典二维 Perlin 噪声，输出约 [-1, 1] */
export class PerlinNoise2D {
  constructor(seed) {
    const rng = mulberry32(seed);
    this.perm = makePermutation(rng);
  }

  noise(x, y) {
    const perm = this.perm;
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);

    const u = fade(xf);
    const v = fade(yf);

    const aa = perm[perm[xi] + yi];
    const ab = perm[perm[xi] + yi + 1];
    const ba = perm[perm[xi + 1] + yi];
    const bb = perm[perm[xi + 1] + yi + 1];

    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
    const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v) * 1.4142;
  }
}

/** 分形布朗运动（多层 Perlin 叠加），输出约 [-1, 1] */
export function fbm2(perlin, x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += perlin.noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** 脊状噪声：用于制造尖锐山脊，输出约 [0, 1] */
export function ridge2(perlin, x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(perlin.noise(x * freq, y * freq));
    sum += n * n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
