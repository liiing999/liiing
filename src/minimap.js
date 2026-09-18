// minimap.js —— 圆形小地图：按世界种子预渲染群岛轮廓，叠加玩家位置 / 朝向、
// 已发现的敌船、未发现的未知目标提示，以及已测绘的岛屿。

import { WORLD_HALF } from './world.js';

const MAP_RANGE = 300; // 小地图显示的世界半径（单位）

export class Minimap {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./world.js').World} world
   */
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.world = world;
    this.size = canvas.width;
    this.center = this.size / 2;
    this.scale = (this.size / 2 - 6) / MAP_RANGE;

    // 离屏 canvas：预渲染群岛底图（只画一次）
    this.baseCanvas = document.createElement('canvas');
    this.baseCanvas.width = this.size;
    this.baseCanvas.height = this.size;
    this._renderBase();
  }

  /** 世界坐标 -> 小地图坐标。 */
  _toMap(wx, wz, px, pz) {
    return {
      x: this.center + (wx - px) * this.scale,
      y: this.center + (wz - pz) * this.scale
    };
  }

  /** 预渲染以原点为中心的群岛轮廓（粗略采样高度，滩涂与陆地分色）。 */
  _renderBase() {
    const ctx = this.baseCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const step = 4; // 像素级采样步长，平衡性能与轮廓清晰度
    for (let py = 0; py < this.size; py += step) {
      for (let px = 0; px < this.size; px += step) {
        const wx = (px - this.center) / this.scale;
        const wz = (py - this.center) / this.scale;
        const h = this.world.getHeight(wx, wz);
        if (h > 1.6) ctx.fillStyle = '#4f9a48';       // 草地
        else if (h > 0.2) ctx.fillStyle = '#d8c98f';  // 沙滩
        else if (h > -1.8) ctx.fillStyle = '#3f8fa6'; // 浅滩
        else continue;
        ctx.fillRect(px, py, step, step);
      }
    }
  }

  /**
   * 每帧绘制。
   * @param {import('./ship.js').Ship} player
   * @param {Array<{ship:import('./ship.js').Ship, discovered:boolean}>} enemies
   * @param {Set<number>} mappedIslands 已测绘岛屿索引集合
   */
  draw(player, enemies, mappedIslands) {
    const ctx = this.ctx;
    const px = player.position.x;
    const pz = player.position.z;

    // 海水底
    ctx.clearRect(0, 0, this.size, this.size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.center, this.center, this.center - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#123e5c';
    ctx.fillRect(0, 0, this.size, this.size);

    // 把预渲染底图按玩家位置平移（底图以世界原点为中心）
    const offsetX = this.center - px * this.scale;
    const offsetY = this.center - pz * this.scale;
    ctx.drawImage(this.baseCanvas, offsetX, offsetY);

    // 世界边界提示
    this._drawWorldBounds(ctx, px, pz);

    // 已测绘岛屿中心标记
    ctx.strokeStyle = 'rgba(255,230,150,.8)';
    ctx.lineWidth = 1;
    for (const idx of mappedIslands) {
      const isl = this.world.islands[idx];
      if (!isl) continue;
      const m = this._toMap(isl.x, isl.z, px, pz);
      ctx.beginPath();
      ctx.arc(m.x, m.y, 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 敌船：已发现显示红色，未发现显示“未知目标”问号（距离够近才提示）
    for (const entry of enemies) {
      const s = entry.ship;
      if (!s.alive) continue;
      const d = Math.hypot(s.position.x - px, s.position.z - pz);
      if (d > MAP_RANGE) continue;
      const m = this._toMap(s.position.x, s.position.z, px, pz);
      if (entry.discovered) {
        this._drawBoat(ctx, m.x, m.y, s.heading, '#ff5a4d');
      } else if (d < 200) {
        ctx.fillStyle = 'rgba(255,255,255,.7)';
        ctx.font = 'bold 13px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('?', m.x, m.y + 4);
      }
    }

    // 玩家（白色三角）
    this._drawBoat(ctx, this.center, this.center, player.heading, '#ffffff');

    ctx.restore();

    // 外圈与方位
    ctx.strokeStyle = '#d8e8f4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.center, this.center, this.center - 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#cfe8ff';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', this.center, 12);
    ctx.fillText('S', this.center, this.size - 4);
  }

  /** 绘制一艘船的三角图标与艏向。 */
  _drawBoat(ctx, x, y, heading, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4, 5);
    ctx.lineTo(0, 2.5);
    ctx.lineTo(-4, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** 画出有限世界的边界方框（部分可见）。 */
  _drawWorldBounds(ctx, px, pz) {
    const corners = [
      [-WORLD_HALF, -WORLD_HALF],
      [WORLD_HALF, -WORLD_HALF],
      [WORLD_HALF, WORLD_HALF],
      [-WORLD_HALF, WORLD_HALF]
    ];
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    corners.forEach((c, i) => {
      const m = this._toMap(c[0], c[1], px, pz);
      if (i === 0) ctx.moveTo(m.x, m.y);
      else ctx.lineTo(m.x, m.y);
    });
    ctx.closePath();
    ctx.stroke();
  }
}
