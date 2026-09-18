// ============================================================
// minimap.js —— 世界小地图
//  - 按世界种子预渲染群岛轮廓（采样世界高度场，结果缓存）
//  - 绘制自身位置 / 朝向、已发现敌船、已测绘岛屿
//  - 未发现敌船不显示具体位置
// ============================================================
import { WORLD_W, WATER_LEVEL } from "./world.js";

const MAP_RES = 256;       // 预渲染底图分辨率
const VIEW_RANGE = 430;    // 小地图显示半径（世界单位）

// 底图按种子缓存，避免每次进游戏重复栅格化
const baseCache = new Map();

export class Minimap {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {World} world
   */
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.world = world;
    this.size = canvas.width;
    this.base = this._renderBase();
  }

  /** 用高度场栅格化全岛轮廓（一次生成，缓存） */
  _renderBase() {
    const cached = baseCache.get(this.world.seed);
    if (cached) return cached;

    const c = document.createElement("canvas");
    c.width = MAP_RES;
    c.height = MAP_RES;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    // 每 2 像素采样一次（约 6m/像素）
    const step = 2;
    const half = WORLD_W / 2;
    for (let py = 0; py < MAP_RES; py += step) {
      for (let px = 0; px < MAP_RES; px += step) {
        const wx = -half + (px / MAP_RES) * WORLD_W;
        const wz = -half + (py / MAP_RES) * WORLD_W;
        const h = this.world.heightAt(wx, wz);
        if (h > WATER_LEVEL + 0.05) {
          // 陆地：沙滩 → 草地 → 山地色
          let color;
          if (h < 1.1) color = "#d9c78e";
          else if (h < 9) color = "#4f9243";
          else if (h < 18) color = "#7d8a4e";
          else color = "#8b867c";
          ctx.fillStyle = color;
          ctx.fillRect(px, py, step, step);
        } else if (h > -2.4) {
          // 浅滩
          ctx.fillStyle = "#2f7d80";
          ctx.fillRect(px, py, step, step);
        }
      }
    }
    baseCache.set(this.world.seed, c);
    return c;
  }

  /**
   * 每帧重绘
   * @param {Ship} player
   * @param {EnemyManager} enemyManager
   * @param {Set<number>} mappedIslands 已测绘岛屿索引集合
   * @param {number} windAngle 风吹向角（弧度，与 heading 同系）
   */
  draw(player, enemyManager, mappedIslands, windAngle) {
    const ctx = this.ctx;
    const s = this.size;
    const cx = s / 2;
    const cy = s / 2;
    const scale = (s / 2) / VIEW_RANGE; // 世界单位 → 像素
    const half = WORLD_W / 2;

    // ---- 海水背景 ----
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = "#0d2f49";
    ctx.beginPath();
    ctx.arc(cx, cy, s / 2 - 2, 0, Math.PI * 2);
    ctx.fill();

    // ---- 以玩家为中心切片底图 ----
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, s / 2 - 2, 0, Math.PI * 2);
    ctx.clip();

    // 底图像素对应的世界跨度
    const pxPerWorld = MAP_RES / WORLD_W;
    // 底图中玩家位置
    const playerMapX = (player.position.x + half) * pxPerWorld;
    const playerMapY = (player.position.z + half) * pxPerWorld;
    // 屏幕上玩家居中：drawImage 源窗口 = 以玩家为中心
    const worldSpan = VIEW_RANGE * 2;
    const srcSpan = worldSpan * pxPerWorld;
    ctx.drawImage(
      this.base,
      playerMapX - srcSpan / 2,
      playerMapY - srcSpan / 2,
      srcSpan,
      srcSpan,
      0,
      0,
      s,
      s
    );

    // ---- 已测绘岛屿标记（金色描边光圈） ----
    if (mappedIslands && mappedIslands.size) {
      ctx.strokeStyle = "rgba(255,216,120,0.9)";
      ctx.lineWidth = 1.5;
      for (const idx of mappedIslands) {
        const isl = this.world.islands[idx];
        if (!isl) continue;
        const sx = cx + (isl.cx - player.position.x) * scale;
        const sy = cy + (isl.cz - player.position.z) * scale;
        const r = Math.max(6, Math.max(isl.rx, isl.rz) * scale);
        ctx.beginPath();
        ctx.ellipse(sx, sy, r, r * 0.8, isl.rot, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // ---- 已发现的敌船：红色；未发现不显示 ----
    for (const enemy of enemyManager.enemies) {
      if (enemy.ship.sunk || !enemyManager.discovered.has(enemy.id)) continue;
      const sx = cx + (enemy.ship.position.x - player.position.x) * scale;
      const sy = cy + (enemy.ship.position.z - player.position.z) * scale;
      if (Math.hypot(sx - cx, sy - cy) > s / 2 - 6) continue;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(-enemy.ship.heading);
      ctx.fillStyle = enemy.state === "撤退" ? "#b98cff" : "#ff5147";
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(3.4, 5);
      ctx.lineTo(0, 3);
      ctx.lineTo(-3.4, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // ---- 风向箭头（背景固定在左上小角，和罗盘同系） ----
    this._drawWindArrow(ctx, windAngle);

    // ---- 玩家：白色三角 + 朝向 ----
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-player.heading);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#0b2136";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(-5, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // ---- 视野范围环 ----
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.35, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();

    // ---- 外圈 ----
    ctx.strokeStyle = "rgba(150,210,255,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, s / 2 - 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** 右上角小型固定风向箭头 */
  _drawWindArrow(ctx, windAngle) {
    const ax = 24;
    const ay = 24;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.fillStyle = "rgba(6,20,36,0.55)";
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, Math.PI * 2);
    ctx.fill();
    // windAngle: 风吹向；箭头指向吹向
    ctx.rotate(-windAngle);
    ctx.fillStyle = "#9fe0ff";
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(4, 4);
    ctx.lineTo(0, 1);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
