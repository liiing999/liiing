// textures.js —— 全部纹理均由 Canvas 2D 动态生成，不使用任何外部图片资源。
// 所有 CanvasTexture 统一使用 NearestFilter，呈现像素风。

import * as THREE from 'three';

/**
 * 把一个 2D canvas 包装成像素风 CanvasTexture
 * @param {HTMLCanvasElement} canvas
 * @param {boolean} repeat 是否启用重复包裹
 * @returns {THREE.CanvasTexture}
 */
function toTexture(canvas, repeat = false) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  tex.needsUpdate = true;
  return tex;
}

/** 创建指定尺寸的画布与 2D 上下文 */
function makeCanvas(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

/**
 * 船舷木纹（深棕底 + 横向木纹 + 铆钉）
 * @returns {THREE.CanvasTexture}
 */
function woodTexture() {
  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#6b4426';
  ctx.fillRect(0, 0, size, size);
  // 木纹亮带
  for (let y = 0; y < size; y += 4) {
    const shade = 90 + ((y * 37) % 50);
    ctx.fillStyle = `rgb(${shade + 30},${shade - 6},${shade - 40})`;
    for (let x = 0; x < size; x += 4) {
      const r = (x * 11 + y * 7) % 13;
      if (r < 6) ctx.fillRect(x, y, 4, 2);
    }
  }
  // 深色木板缝
  ctx.fillStyle = 'rgba(30,16,6,.55)';
  for (let y = 0; y < size; y += 16) ctx.fillRect(0, y, size, 2);
  // 铆钉
  ctx.fillStyle = '#241609';
  for (let y = 8; y < size; y += 16) {
    for (let x = 8; x < size; x += 16) {
      ctx.fillRect(x, y, 2, 2);
      ctx.fillStyle = '#8a6a42';
      ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = '#241609';
    }
  }
  return toTexture(canvas, true);
}

/**
 * 甲板木纹（更浅的纵向木板）
 * @returns {THREE.CanvasTexture}
 */
function deckTexture() {
  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#9a6a38';
  ctx.fillRect(0, 0, size, size);
  for (let x = 0; x < size; x += 8) {
    const shade = 120 + ((x * 23) % 40);
    ctx.fillStyle = `rgb(${shade + 40},${shade},${shade - 50})`;
    ctx.fillRect(x + 1, 0, 6, size);
    ctx.fillStyle = 'rgba(50,28,10,.6)';
    ctx.fillRect(x, 0, 1, size);
  }
  // 少量脏点
  ctx.fillStyle = 'rgba(60,36,14,.5)';
  for (let i = 0; i < 40; i++) {
    const x = (i * 17) % size;
    const y = (i * 31) % size;
    ctx.fillRect(x, y, 2, 2);
  }
  return toTexture(canvas, true);
}

/**
 * 帆布纹理（米白底 + 织纹 + 缝线），深色版本用于海盗
 * @param {string} base
 * @param {string} line
 * @param {boolean} pirate
 * @returns {THREE.CanvasTexture}
 */
function sailTexture(base, line, pirate = false) {
  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  // 织物网点
  ctx.fillStyle = 'rgba(0,0,0,.05)';
  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size; x += 2) {
      if ((x + y) % 4 === 0) ctx.fillRect(x, y, 1, 1);
    }
  }
  // 缝线
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  for (let y = 0; y <= size; y += 16) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  // 补丁
  ctx.fillStyle = pirate ? 'rgba(70,50,30,.55)' : 'rgba(150,130,90,.5)';
  ctx.fillRect(8, 10, 8, 7);
  ctx.fillRect(44, 40, 10, 8);
  if (pirate) {
    // 海盗红黑横条
    ctx.fillStyle = 'rgba(150,30,20,.55)';
    ctx.fillRect(0, 20, size, 6);
    ctx.fillRect(0, 44, size, 6);
  }
  return toTexture(canvas, false);
}

/**
 * 玩家旗帜（蓝底白帆图案）
 * @returns {THREE.CanvasTexture}
 */
function flagPlayerTexture() {
  const size = 32;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#235a8c';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#f2ead0';
  // 简化白帆
  ctx.fillRect(13, 6, 2, 20);
  ctx.beginPath();
  ctx.moveTo(15, 7);
  ctx.lineTo(27, 12);
  ctx.lineTo(15, 16);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(15, 18);
  ctx.lineTo(26, 23);
  ctx.lineTo(15, 27);
  ctx.closePath();
  ctx.fill();
  return toTexture(canvas, false);
}

/**
 * 海盗旗（黑底白骷髅交叉骨）
 * @returns {THREE.CanvasTexture}
 */
function flagPirateTexture() {
  const size = 32;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#151515';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#ececec';
  // 头骨
  ctx.fillRect(11, 7, 10, 8);
  ctx.fillRect(13, 15, 6, 3);
  ctx.fillStyle = '#151515';
  ctx.fillRect(13, 10, 2, 3);
  ctx.fillRect(17, 10, 2, 3);
  ctx.fillStyle = '#ececec';
  // 交叉骨
  ctx.fillRect(7, 19, 18, 2);
  ctx.fillRect(8, 23, 16, 2);
  return toTexture(canvas, false);
}

/**
 * 浪花 / 水柱贴片（白色放射泡沫）
 * @returns {THREE.CanvasTexture}
 */
function splashTexture() {
  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  // 多圈像素泡
  for (let ring = 0; ring < 4; ring++) {
    const radius = 6 + ring * 7;
    const count = 10 + ring * 4;
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + ring;
      const px = Math.round(cx + Math.cos(ang) * radius);
      const py = Math.round(cy + Math.sin(ang) * radius);
      const alpha = 0.9 - ring * 0.18;
      ctx.fillStyle = `rgba(235,245,255,${alpha})`;
      const s = ring === 0 ? 4 : 3;
      ctx.fillRect(px - (s >> 1), py - (s >> 1), s, s);
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.fillRect(cx - 3, cy - 3, 6, 6);
  return toTexture(canvas, false);
}

/**
 * 烟雾贴片（灰黑柔边像素团）
 * @returns {THREE.CanvasTexture}
 */
function smokeTexture() {
  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  ctx.clearRect(0, 0, size, size);
  for (let ring = 0; ring < 5; ring++) {
    const radius = ring * 6;
    const count = 14;
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + ring * 0.7;
      const r = radius + ((i * 3 + ring) % 4);
      const px = Math.round(size / 2 + Math.cos(ang) * r);
      const py = Math.round(size / 2 + Math.sin(ang) * r);
      const alpha = 0.32 - ring * 0.05;
      ctx.fillStyle = `rgba(70,70,72,${Math.max(alpha, 0.05)})`;
      ctx.fillRect(px - 3, py - 3, 6, 6);
    }
  }
  ctx.fillStyle = 'rgba(40,40,42,.4)';
  ctx.fillRect(28, 28, 8, 8);
  return toTexture(canvas, false);
}

/**
 * 云贴片（白色蓬松像素团）
 * @returns {THREE.CanvasTexture}
 */
function cloudTexture() {
  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  ctx.clearRect(0, 0, size, size);
  const blobs = [
    [32, 38, 20], [20, 40, 13], [45, 40, 14], [30, 28, 13], [40, 30, 10]
  ];
  for (const [bx, by, br] of blobs) {
    for (let y = -br; y <= br; y += 2) {
      for (let x = -br; x <= br; x += 2) {
        if (x * x + y * y <= br * br) {
          ctx.fillStyle = 'rgba(255,255,255,.85)';
          ctx.fillRect(bx + x, by + y, 2, 2);
        }
      }
    }
  }
  return toTexture(canvas, false);
}

/**
 * 炮口火光贴片
 * @returns {THREE.CanvasTexture}
 */
function flashTexture() {
  const size = 32;
  const { canvas, ctx } = makeCanvas(size);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  for (let ring = 0; ring < 4; ring++) {
    const radius = 2 + ring * 3;
    const count = 8;
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2;
      const px = Math.round(cx + Math.cos(ang) * radius);
      const py = Math.round(cy + Math.sin(ang) * radius);
      ctx.fillStyle = ring < 2 ? 'rgba(255,240,170,.95)' : 'rgba(255,150,40,.7)';
      ctx.fillRect(px - 2, py - 2, 4, 4);
    }
  }
  return toTexture(canvas, false);
}

/** 纹理集合缓存，避免重复生成 */
let cache = null;

/**
 * 获取全部共享纹理（单例）
 * @returns {Record<string, THREE.Texture>}
 */
export function getTextures() {
  if (cache) return cache;
  cache = {
    wood: woodTexture(),
    deck: deckTexture(),
    sail: sailTexture('#e8e0c4', 'rgba(120,105,70,.7)', false),
    sailPirate: sailTexture('#c9b48f', 'rgba(80,60,40,.75)', true),
    flagPlayer: flagPlayerTexture(),
    flagPirate: flagPirateTexture(),
    splash: splashTexture(),
    smoke: smokeTexture(),
    cloud: cloudTexture(),
    flash: flashTexture()
  };
  return cache;
}
