// ============================================================
// textures.js —— 全部纹理均由 Canvas 2D 程序化生成
// 统一 NearestFilter，呈现像素风。游戏不加载任何外部图片。
// ============================================================
import * as THREE from "three";

/** 创建像素风 Canvas 纹理（低分辨率 → 像素感） */
function canvasTexture(w, h, draw, opts = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  draw(ctx, w, h);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  if (!opts.transparent) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  if (opts.repeat) tex.repeat.set(opts.repeat[0], opts.repeat[1]);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 线性同余随机，保证每次生成的纹理一致 */
function texRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function speckle(ctx, w, h, count, colors, rng) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(rng() * colors.length)];
    ctx.fillRect(Math.floor(rng() * w), Math.floor(rng() * h), 1, 1);
  }
}

/** 帆布纹理：米白编织 + 缝线补丁 */
export function makeSailTexture() {
  return canvasTexture(32, 32, (ctx, w, h) => {
    const rng = texRng(101);
    ctx.fillStyle = "#e8ddc0";
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 4) {
      ctx.fillStyle = "rgba(120,100,60,0.25)";
      ctx.fillRect(0, y, w, 1);
    }
    for (let x = 0; x < w; x += 4) {
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(x, 0, 1, h);
    }
    ctx.fillStyle = "#b09a68";
    ctx.fillRect(0, 0, w, 2);
    ctx.fillRect(0, h - 2, w, 2);
    ctx.fillStyle = "#cbb98c";
    ctx.fillRect(20, 18, 8, 8);
    ctx.strokeStyle = "#8a764a";
    ctx.strokeRect(20.5, 18.5, 7, 7);
    speckle(ctx, w, h, 90, ["rgba(120,100,60,0.25)", "rgba(255,255,255,0.2)"], rng);
  });
}

/** 船舷木纹：深浅交错的木板 + 钉眼 */
export function makeWoodTexture() {
  return canvasTexture(32, 32, (ctx, w, h) => {
    const rng = texRng(202);
    ctx.fillStyle = "#7a4a22";
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 8) {
      const base = 90 + Math.floor(rng() * 40);
      ctx.fillStyle = `rgb(${base + 30},${base - 6},${base - 42})`;
      ctx.fillRect(0, y + 1, w, 6);
      ctx.fillStyle = "rgba(60,32,12,0.5)";
      for (let x = 0; x < w; x++) {
        if (rng() > 0.6) ctx.fillRect(x, y + 2 + Math.floor(rng() * 4), 1, 1);
      }
      ctx.fillStyle = "#3f2410";
      ctx.fillRect(0, y, w, 1);
      ctx.fillStyle = "#2e1a0a";
      ctx.fillRect(3, y + 2, 1, 1);
      ctx.fillRect(w - 4, y + 5, 1, 1);
    }
    speckle(ctx, w, h, 60, ["rgba(0,0,0,0.18)", "rgba(255,220,160,0.12)"], rng);
  });
}

/** 玩家阵营旗帜：蓝底金锚 */
export function makeFlagTexture() {
  return canvasTexture(16, 16, (ctx) => {
    ctx.fillStyle = "#1f5d9e";
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = "#ffd76a";
    // 像素锚图案
    ctx.fillRect(7, 2, 2, 2);
    ctx.fillRect(6, 4, 4, 1);
    ctx.fillRect(7, 5, 2, 6);
    ctx.fillRect(4, 9, 8, 1);
    ctx.fillRect(4, 9, 1, 3);
    ctx.fillRect(11, 9, 1, 3);
    ctx.fillRect(3, 12, 2, 1);
    ctx.fillRect(11, 12, 2, 1);
    ctx.fillRect(5, 11, 1, 1);
    ctx.fillRect(10, 11, 1, 1);
  }, { transparent: true });
}

/** 海盗旗：黑底白色骷髅交叉骨 */
export function makePirateFlagTexture() {
  return canvasTexture(16, 16, (ctx) => {
    ctx.fillStyle = "#151515";
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = "#f2f2f2";
    // 交叉骨
    ctx.fillRect(2, 10, 2, 1);
    ctx.fillRect(4, 8, 1, 1);
    ctx.fillRect(12, 10, 2, 1);
    ctx.fillRect(11, 8, 1, 1);
    ctx.fillRect(5, 7, 6, 1);
    ctx.fillRect(4, 8, 1, 4);
    ctx.fillRect(11, 8, 1, 4);
    ctx.fillRect(5, 12, 6, 1);
    // 骷髅头
    ctx.fillRect(6, 3, 4, 3);
    ctx.fillRect(5, 4, 1, 2);
    ctx.fillRect(10, 4, 1, 2);
    ctx.fillStyle = "#151515";
    ctx.fillRect(6, 4, 1, 1);
    ctx.fillRect(9, 4, 1, 1);
    ctx.fillStyle = "#f2f2f2";
    ctx.fillRect(6, 6, 1, 1);
    ctx.fillRect(8, 6, 1, 1);
    ctx.fillRect(9, 6, 1, 1);
  }, { transparent: true });
}

/** 浪花 / 水柱贴片 */
export function makeFoamTexture() {
  return canvasTexture(16, 16, (ctx, w, h) => {
    const rng = texRng(303);
    const cx = w / 2;
    const cy = h / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / (w / 2);
        if (d < 0.9 && rng() > d * 0.95) {
          const a = Math.max(0, 1 - d) * 0.95;
          ctx.fillStyle = `rgba(240,250,255,${a.toFixed(2)})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  }, { transparent: true });
}

/** 烟雾贴片：灰黑软团 */
export function makeSmokeTexture() {
  return canvasTexture(16, 16, (ctx, w, h) => {
    const rng = texRng(404);
    const cx = w / 2;
    const cy = h / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / (w / 2);
        if (d < 0.95 && rng() > d * 1.05) {
          const shade = 70 + Math.floor((1 - d) * 60);
          const a = Math.max(0, 0.75 - d * 0.7);
          ctx.fillStyle = `rgba(${shade},${shade},${shade},${a.toFixed(2)})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  }, { transparent: true });
}

/** 炮口火光贴片 */
export function makeFlashTexture() {
  return canvasTexture(12, 12, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / (w / 2);
        if (d < 1) {
          const hot = 1 - d;
          const g = Math.floor(120 + hot * 130);
          const b = Math.floor(hot * 60);
          ctx.fillStyle = `rgba(255,${g},${b},${(hot * 0.95).toFixed(2)})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  }, { transparent: true });
}

/** 程序化云朵贴片 */
export function makeCloudTexture() {
  return canvasTexture(32, 16, (ctx, w, h) => {
    const rng = texRng(505);
    for (let i = 0; i < 14; i++) {
      const rx = 3 + Math.floor(rng() * 5);
      const ry = 2 + Math.floor(rng() * 3);
      const x = 4 + Math.floor(rng() * (w - 8));
      const y = 6 + Math.floor(rng() * (h - 10));
      for (let yy = -ry; yy <= ry; yy++) {
        for (let xx = -rx; xx <= rx; xx++) {
          if ((xx * xx) / (rx * rx) + (yy * yy) / (ry * ry) <= 1) {
            const px = x + xx;
            const py = y + yy;
            if (px >= 0 && px < w && py >= 0 && py < h) {
              ctx.fillStyle = `rgba(255,255,255,${(0.12 + rng() * 0.1).toFixed(3)})`;
              ctx.fillRect(px, py, 1, 1);
            }
          }
        }
      }
    }
  }, { transparent: true });
}

/** 罗盘刻度盘绘制（Canvas 2D，模型与 UI 共用） */
export function drawCompassDial(ctx, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const r = w / 2 - 2;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#eadfc2";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#5a4626";
  ctx.lineWidth = 2;
  ctx.stroke();
  // 32 个罗经点刻度
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2 - Math.PI / 2;
    const major = i % 8 === 0;
    const half = i % 4 === 0;
    const len = major ? 8 : half ? 5 : 3;
    ctx.strokeStyle = "#3a2c16";
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len));
    ctx.lineTo(cx + Math.cos(a) * (r - 1), cy + Math.sin(a) * (r - 1));
    ctx.stroke();
  }
  ctx.fillStyle = "#7a1f1f";
  ctx.font = `bold ${Math.floor(w * 0.18)}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", cx, cy - r * 0.62);
  ctx.fillStyle = "#3a2c16";
  ctx.fillText("S", cx, cy + r * 0.62);
  ctx.fillText("E", cx + r * 0.62, cy);
  ctx.fillText("W", cx - r * 0.62, cy);
}

/** 罗盘刻度盘纹理（驾驶舱罗盘模型使用） */
export function makeCompassDialTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  drawCompassDial(ctx, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
