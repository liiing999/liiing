// ============================================================
// ui.js —— HUD / 罗盘 / 菜单 / 调试面板
//  - 罗盘（Canvas 绘制刻度 + 船头游标 + 风向箭头）
//  - 航速 / 水深 / 耐久 / 帆效率 / 火炮装填
//  - 开始 / 暂停菜单、设置项读写、Toast 提示
// ============================================================

const CARDINALS = [
  { angle: 0, label: "N" },
  { angle: Math.PI / 2, label: "E" },
  { angle: Math.PI, label: "S" },
  { angle: -Math.PI / 2, label: "W" },
];

function headingLabel(h) {
  // 0=北，顺时针
  const deg = ((h * 180) / Math.PI) % 360;
  const dirs = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  return dirs[Math.round(deg / 45) % 8];
}

export class UI {
  constructor() {
    // HUD
    this.hud = document.getElementById("hud");
    this.stats = document.getElementById("stats-panel");
    this.compass = document.getElementById("compass");
    this.cctx = this.compass.getContext("2d");
    this.cctx.imageSmoothingEnabled = false;
    this.speedEl = document.getElementById("hud-speed");
    this.depthEl = document.getElementById("hud-depth");
    this.hpBar = document.getElementById("bar-hp");
    this.sailBar = document.getElementById("bar-sail");
    this.sailPct = document.getElementById("hud-sail-pct");
    this.gunPort = document.getElementById("gun-port");
    this.gunStar = document.getElementById("gun-star");
    this.hint = document.getElementById("hud-hint");
    this.spyOverlay = document.getElementById("spyglass-overlay");

    this.debug = document.getElementById("debug-panel");
    this.minimapCanvas = document.getElementById("minimap");

    // 菜单
    this.startScreen = document.getElementById("start-screen");
    this.pauseScreen = document.getElementById("pause-screen");
    this.toastEl = document.getElementById("toast");
    this.saveInfo = document.getElementById("save-info");

    this.setView = document.getElementById("set-view");
    this.setSens = document.getElementById("set-sens");
    this.setQuality = document.getElementById("set-quality");

    this._toastTimer = 0;
    this._hintTimer = 0;
  }

  showHUD(on) {
    this.hud.classList.toggle("hidden", !on);
  }

  showStart(on) {
    this.startScreen.classList.toggle("hidden", !on);
  }

  showPause(on) {
    this.pauseScreen.classList.toggle("hidden", !on);
  }

  showSpyglass(on) {
    this.spyOverlay.classList.toggle("hidden", !on);
  }

  setSaveInfo(text) {
    this.saveInfo.textContent = text || "";
  }

  /** 中央短暂提示 */
  toast(text, duration = 2.2) {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove("hidden");
    this._toastTimer = duration;
  }

  /** 船面板底部的短期提示（如“触礁！”） */
  hintLine(text, duration = 1.4) {
    this.hint.textContent = text;
    this._hintTimer = duration;
  }

  tickTimers(dt) {
    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.toastEl.classList.add("hidden");
    }
    if (this._hintTimer > 0) {
      this._hintTimer -= dt;
      if (this._hintTimer <= 0) this.hint.textContent = "";
    }
  }

  // ----------------------------------------------------------
  // 设置
  // ----------------------------------------------------------
  readSettingsForm(current) {
    return {
      viewDistance: parseInt(this.setView.value, 10) || current.viewDistance,
      sensitivity: parseFloat(this.setSens.value) || current.sensitivity,
      quality: this.setQuality.value || current.quality,
    };
  }

  writeSettingsForm(settings) {
    this.setView.value = String(settings.viewDistance);
    this.setSens.value = String(settings.sensitivity);
    this.setQuality.value = settings.quality;
  }

  // ----------------------------------------------------------
  // 罗盘（Canvas 绘制）
  // ----------------------------------------------------------
  /**
   * @param {number} heading 船头朝向（0=北）
   * @param {number} windAngle 风吹向角（0=北风往南？这里统一定义为吹向角）
   * @param {number} efficiency 帆效率
   */
  drawCompass(heading, windAngle, efficiency) {
    const ctx = this.cctx;
    const w = this.compass.width;
    const h = this.compass.height;
    ctx.clearRect(0, 0, w, h);

    // 半透明底
    ctx.fillStyle = "rgba(8,24,40,0.55)";
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const pxPerRad = 70; // 每弧度对应像素
    ctx.font = "bold 13px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // 绘制可见范围内的刻度（每 15° 一条短线，每 90° 方位字母）
    const halfView = w / 2 / pxPerRad;
    for (let a = -Math.PI * 2; a <= Math.PI * 2; a += Math.PI / 12) {
      const screenX = cx + (a - heading) * pxPerRad;
      if (screenX < -10 || screenX > w + 10) continue;
      const major = Math.abs(((a / (Math.PI / 2)) % 2)) < 0.01;
      const halfTick = Math.abs(((a / (Math.PI / 4)) % 2)) < 0.01;
      ctx.strokeStyle = major ? "#ffd98a" : "rgba(230,245,255,0.8)";
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(screenX, 6);
      ctx.lineTo(screenX, major || halfTick ? 16 : 11);
      ctx.stroke();
      if (major) {
        const norm = normalizeAngle(a);
        const card = CARDINALS.find((c) => Math.abs(c.angle - norm) < 0.01);
        if (card) {
          ctx.fillStyle = card.label === "N" ? "#ff7a6e" : "#eaf6ff";
          ctx.fillText(card.label, screenX, 30);
        }
      }
    }

    // 风向箭头（画在罗盘带上，对应风吹来/吹向位置）
    const windX = cx + (windAngle - heading) * pxPerRad;
    if (windX > 6 && windX < w - 6) {
      ctx.save();
      ctx.translate(windX, 40);
      ctx.fillStyle = "#7ee0ff";
      ctx.beginPath();
      ctx.moveTo(0, 5);
      ctx.lineTo(-4.5, -3);
      ctx.lineTo(0, -1);
      ctx.lineTo(4.5, -3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 中央船头游标
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(cx, 2);
    ctx.lineTo(cx - 5, 11);
    ctx.lineTo(cx + 5, 11);
    ctx.closePath();
    ctx.fill();
  }

  // ----------------------------------------------------------
  // 船舶 HUD
  // ----------------------------------------------------------
  updateShipHUD(ship, depth) {
    this.speedEl.textContent = ship.speedKnots.toFixed(1) + " 节";
    this.depthEl.textContent = depth < 0.05 ? "搁浅" : depth.toFixed(1) + " m";
    this.hpBar.style.width = (ship.hp / ship.maxHp) * 100 + "%";
    const effPct = Math.round(ship.efficiency * 100);
    this.sailBar.style.width = effPct + "%";
    this.sailPct.textContent = effPct + "%";
    this.setGun(this.gunPort, ship.gunProgress(-1));
    this.setGun(this.gunStar, ship.gunProgress(1));
  }

  setGun(el, progress) {
    const ready = progress >= 1;
    el.className = ready ? "gun-ready" : "gun-cool";
    if (!ready) {
      el.style.background =
        "linear-gradient(90deg,#ffc24d " + progress * 100 + "%,rgba(80,80,80,0.85) " + progress * 100 + "%)";
    } else {
      el.style.background = "";
    }
  }

  // ----------------------------------------------------------
  // 左上状态
  // ----------------------------------------------------------
  updateStats(info) {
    const mode = [
      info.anchored ? "抛锚" : "航行",
      info.firstPerson ? "第一人称" : "第三人称",
      info.spyglass ? "望远镜" : "",
    ].filter(Boolean).join(" / ");
    this.stats.textContent =
      `FPS        ${info.fps}\n` +
      `世界坐标   X ${info.x.toFixed(1)}  Y ${info.y.toFixed(1)}  Z ${info.z.toFixed(1)}\n` +
      `当前区块   ${info.chunkX} , ${info.chunkZ}\n` +
      `天气       ${info.weather}\n` +
      `时段       ${info.timeOfDay}\n` +
      `风力       ${info.windLabel}（${Math.round(info.wind * 100)}%）\n` +
      `航向       ${headingLabel(info.heading)} ${((info.heading * 180) / Math.PI % 360).toFixed(0)}°\n` +
      `战果       击沉 ${info.sunk} / ${info.total} 艘海盗\n` +
      `状态       ${mode}`;
  }

  // ----------------------------------------------------------
  // F3 调试面板
  // ----------------------------------------------------------
  toggleDebug(force) {
    const show = force != null ? force : this.debug.classList.contains("hidden");
    this.debug.classList.toggle("hidden", !show);
    return show;
  }

  updateDebug(info, aiLines) {
    this.debug.textContent =
      `区块数量   ${info.chunks}（视距 R${info.viewRadius}）\n` +
      `draw call  ${info.calls}\n` +
      `三角形     ${info.triangles}\n` +
      (info.jsHeap != null ? `JS 堆占用  ${(info.jsHeap / 1048576).toFixed(1)} MB\n` : "JS 堆占用  不支持\n") +
      `天气 / 时段 ${info.weather} / ${info.timeOfDay}\n` +
      `波高系数   x${info.waveScale.toFixed(2)}\n` +
      `—— AI 状态 ——\n` +
      aiLines.join("\n");
  }
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
