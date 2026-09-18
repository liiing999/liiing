// noise.js —— 自实现的确定性随机数与多层值噪声 / Perlin 噪声
// 不依赖任何第三方 noise 库。全部函数可由种子复现，供地形与世界生成使用。

/**
 * 32 位整数哈希（用于把坐标映射成伪随机数）
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number} 0..1
 */
export function hash2(x, y, seed = 0) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1442695040;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  // 转为无符号再归一化到 [0,1)
  return (h >>> 0) / 4294967296;
}

/**
 * mulberry32 伪随机数发生器
 * @param {number} seed 整数种子
 * @returns {() => number} 返回一个产生 [0,1) 随机数的函数
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平滑插值函数（6t^5-15t^4+10t^3），保证一阶、二阶导数连续 */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 线性插值 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 梯度表（8 个二维方向） */
const GRAD2 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [-0.7071, 0.7071],
  [0.7071, -0.7071], [-0.7071, -0.7071]
];

/**
 * 二维 Perlin 噪声（自实现）。
 * 通过整数格点哈希选梯度，再做平滑插值，输出约 [-1,1]。
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number}
 */
export function perlin2(x, y, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xf = x - x0;
  const yf = y - y0;

  const g00 = GRAD2[(hash2(x0, y0, seed) * GRAD2.length) | 0];
  const g10 = GRAD2[(hash2(x0 + 1, y0, seed) * GRAD2.length) | 0];
  const g01 = GRAD2[(hash2(x0, y0 + 1, seed) * GRAD2.length) | 0];
  const g11 = GRAD2[(hash2(x0 + 1, y0 + 1, seed) * GRAD2.length) | 0];

  const d00 = g00[0] * xf + g00[1] * yf;
  const d10 = g10[0] * (xf - 1) + g10[1] * yf;
  const d01 = g01[0] * xf + g01[1] * (yf - 1);
  const d11 = g11[0] * (xf - 1) + g11[1] * (yf - 1);

  const u = fade(xf);
  const v = fade(yf);
  return lerp(lerp(d00, d10, u), lerp(d01, d11, u), v);
}

/**
 * 二维值噪声（格点随机高度 + 平滑插值），输出约 [0,1]
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number}
 */
export function valueNoise2(x, y, seed = 0) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xf = x - x0;
  const yf = y - y0;

  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x0 + 1, y0, seed);
  const v01 = hash2(x0, y0 + 1, seed);
  const v11 = hash2(x0 + 1, y0 + 1, seed);

  const u = fade(xf);
  const v = fade(yf);
  return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
}

/**
 * 分形布朗运动（多层 Perlin 叠加），输出约 [-1,1]
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @param {number} octaves 层数
 * @param {number} lacunarity 频率倍增
 * @param {number} gain 振幅衰减
 * @returns {number}
 */
export function fbm2(x, y, seed = 0, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 0.5;
  let freq = 1.0;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * perlin2(x * freq, y * freq, seed + i * 101);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * ridged 分形噪声：在山脊处形成尖锐峰值，适合做山峰。输出约 [0,1]
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @param {number} octaves
 * @returns {number}
 */
export function ridged2(x, y, seed = 0, octaves = 4) {
  let amp = 0.55;
  let freq = 1.0;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(perlin2(x * freq, y * freq, seed + i * 71));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}
