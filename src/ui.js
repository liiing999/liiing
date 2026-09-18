// ui.js —— HUD（Canvas 罗盘 + 风向箭头 + 帆效率条 / 航速 / 水深 / 耐久 / 装填）、
// 左上状态与调试面板、AI 状态、浮动提示、开始 / 暂停 / 沉没菜单交互。

const DEG = Math.PI / 180;

const CARDINALS = [
  { angle: 0, label: 'N' },
  { angle: 90, label: 'E' },
  { angle: 180, label: 'S' },
  { angle: 270, label: 'W' }
];

export class UI {
  /**
   * @param {object} callbacks 菜单按钮回调
   */
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    // HUD 元素
    this.compass = document.getElementById('compass');
    this.cctx = this.compass.getContext('2d');
    this.el = {
      sailBar: document.getElementById('sail-bar'),
      sailText: document.getElementById('sail-text'),
      sailAmountBar: document.getElementById('sail-amount-bar'),
      sailAmountText: document.getElementById('sail-amount-text'),
      speed: document.getElementById('speed-text'),
      depth: document.getElementById('depth-text'),
      hpBar: document.getElementById('hp-bar'),
      hpText: document.getElementById('hp-text'),
      reloadPort: document.getElementById('reload-port'),
      reloadStar: document.getElementById('reload-star'),
      spyglass: document.getElementById('spyglass-mask'),
      toastLayer: document.getElementById('toast-layer'),
      infoStats: document.getElementById('info-stats'),
      aiPanel: document.getElementById('ai-panel'),
      aiStats: document.getElementById('ai-stats')
    };
    this.screens = {
      hud: document.getElementById('hud'),
      info: document.getElementById('info-panel'),
      start: document.getElementById('start-screen'),
      pause: document.getElementById('pause-screen'),
      sunk: document.getElementById('sunk-screen'),
      mobile: document.getElementById('mobile-notice')
    };

    this._bindMenu();
  }

  /** 绑定开始 / 暂停菜单事件。 */
  _bindMenu() {
    document.getElementById('start-btn').addEventListener('click', () => {
      const difficulty = parseInt(document.getElementById('difficulty-select').value, 10);
      const newSeed = document.getElementById('new-seed-check').checked;
      if (this.callbacks.onStart) this.callbacks.onStart({ difficulty, newSeed });
    });
    document.getElementById('resume-btn').addEventListener('click', () => {
      if (this.callbacks.onResume) this.callbacks.onResume();
    });
    document.getElementById('save-btn').addEventListener('click', () => {
      if (this.callbacks.onSave) {
        const ok = this.callbacks.onSave();
        this.flashHint(ok ? '世界已保存' : '保存失败', ok ? '#4d7c52' : '#a33');
      }
    });
    document.getElementById('reset-same-btn').addEventListener('click', () => {
      if (this.callbacks.onReset) this.callbacks.onReset(false);
    });
    document.getElementById('reset-new-btn').addEventListener('click', () => {
      if (this.callbacks.onReset) this.callbacks.onReset(true);
    });

    // 设置项
    const viewRange = document.getElementById('viewdist-range');
    const viewLabel = document.getElementById('viewdist-label');
    viewRange.addEventListener('input', () => {
      viewLabel.textContent = viewRange.value + ' 块';
      if (this.callbacks.onSettings) this.callbacks.onSettings(this._readSettings());
    });
    const sensRange = document.getElementById('sens-range');
    const sensLabel = document.getElementById('sens-label');
    sensRange.addEventListener('input', () => {
      sensLabel.textContent = Number(sensRange.value).toFixed(1);
      if (this.callbacks.onSettings) this.callbacks.onSettings(this._readSettings());
    });
    const quality = document.getElementById('quality-select');
    quality.addEventListener('change', () => {
      if (this.callbacks.onSettings) this.callbacks.onSettings(this._readSettings());
    });
  }

  /** 读取暂停菜单中的设置值。 */
  _readSettings() {
    return {
      viewDistance: parseInt(document.getElementById('viewdist-range').value, 10),
      sensitivity: parseFloat(document.getElementById('sens-range').value),
      quality: document.getElementById('quality-select').value
    };
  }

  /**
   * 用存档 / 默认设置初始化设置控件。
   * @param {object} settings
   */
  initSettings(settings) {
    document.getElementById('viewdist-range').value = settings.viewDistance;
    document.getElementById('viewdist-label').textContent = settings.viewDistance + ' 块';
    document.getElementById('sens-range').value = settings.sensitivity;
    document.getElementById('sens-label').textContent = Number(settings.sensitivity).toFixed(1);
    document.getElementById('quality-select').value = settings.quality;
  }

  /** 开始界面上的存档提示。 */
  setStartHint(text) {
    document.getElementById('save-hint').textContent = text;
  }

  showScreen(name, visible) {
    const screen = this.screens[name];
    if (screen) screen.classList.toggle('hidden', !visible);
  }

  setDebugVisible(visible) {
    this.el.aiPanel.classList.toggle('hidden', !visible);
  }

  setSpyglass(on) {
    this.el.spyglass.classList.toggle('active', on);
  }

  /**
   * 顶部居中显示一条短暂提示。
   * @param {string} text
   * @param {number} [duration]
   */
  toast(text, duration = 3000) {
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = text;
    this.el.toastLayer.appendChild(div);
    setTimeout(() => div.remove(), duration);
  }

  /** 暂停菜单里的短暂反馈文字。 */
  flashHint(text, color = '#4d7c52') {
    const hint = document.getElementById('save-btn');
    const original = hint.textContent;
    hint.textContent = text;
    hint.style.color = '#ffe9b0';
    setTimeout(() => {
      hint.textContent = original;
      hint.style.color = '';
    }, 1400);
  }

  /**
   * 绘制罗盘：船首刻度固定在中央，刻度盘随航向滚动；叠加风向箭头。
   * @param {number} heading 船艏向（弧度）
   * @param {number} windFrom 风的来向（弧度）
   * @param {number} sailEff 帆效率 0..1
   */
  drawCompass(heading, windFrom, sailEff) {
    const ctx = this.cctx;
    const w = this.compass.width;
    const h = this.compass.height;
    ctx.clearRect(0, 0, w, h);

    // 半透明底条
    ctx.fillStyle = 'rgba(10,28,42,.45)';
    ctx.fillRect(0, 0, w, h);

    const centerX = w / 2;
    const headingDeg = heading / DEG;

    // 刻度盘：把世界方位角转换到屏幕 x
    const worldToScreen = (worldAngleDeg) => {
      let rel = worldAngleDeg - headingDeg;
      while (rel > 180) rel -= 360;
      while (rel < -180) rel += 360;
      return centerX + rel * 2.2;
    };

    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    // 每 15° 一刻度
    for (let deg = 0; deg < 360; deg += 15) {
      const x = worldToScreen(deg);
      if (x < -10 || x > w + 10) continue;
      const major = deg % 90 === 0;
      ctx.strokeStyle = major ? '#ffe9b0' : 'rgba(220,240,255,.7)';
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 12);
      ctx.lineTo(x, major ? 26 : 20);
      ctx.stroke();
      if (major) {
        const card = CARDINALS.find((c) => c.angle === deg);
        ctx.fillStyle = '#ffe9b0';
        ctx.fillText(card ? card.label : String(deg), x, 40);
      }
    }

    // 风向箭头（画在罗盘上方，指向风的来向在世界中的位置）
    const windX = worldToScreen(windFrom / DEG);
    if (windX > 0 && windX < w) {
      ctx.fillStyle = '#8fd0ff';
      ctx.beginPath();
      ctx.moveTo(windX, h - 6);
      ctx.lineTo(windX - 6, h - 18);
      ctx.lineTo(windX + 6, h - 18);
      ctx.closePath();
      ctx.fill();
    }

    // 中央船首指示（黄色三角）
    ctx.fillStyle = '#ffd24d';
    ctx.beginPath();
    ctx.moveTo(centerX, 4);
    ctx.lineTo(centerX - 5, 14);
    ctx.lineTo(centerX + 5, 14);
    ctx.closePath();
    ctx.fill();

    // 帆效率数字（右下角，便于和速度条对应）
    ctx.fillStyle = sailEff > 0.45 ? '#9fe8a0' : sailEff > 0.2 ? '#ffe08a' : '#ff9a7a';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('风 ' + Math.round(sailEff * 100) + '%', w - 8, h - 8);
  }

  /**
   * 更新 HUD 数值条（约每 100ms 调用一次即可）。
   * @param {import('./ship.js').Ship} ship
   * @param {number} depth 水深（米）
   * @param {number} reloadPort 0..1
   * @param {number} reloadStar 0..1
   */
  updateHud(ship, depth, reloadPort, reloadStar) {
    const effPct = Math.round(ship.sailEfficiency * 100);
    this.el.sailBar.style.width = ship.sailEfficiency * 100 + '%';
    this.el.sailText.textContent = effPct + '%';
    this.el.sailAmountBar.style.width = ship.sailAmount * 100 + '%';
    this.el.sailAmountText.textContent = Math.round(ship.sailAmount * 100) + '%';
    this.el.speed.textContent = ship.speedKnots.toFixed(1) + ' 节';

    if (depth == null) {
      this.el.depth.textContent = '-- m';
    } else {
      this.el.depth.textContent = depth.toFixed(1) + ' m';
      this.el.depth.style.color = depth < 3 ? '#ff7a6a' : '#ffffff';
    }

    const hpPct = ship.hp / ship.maxHp;
    this.el.hpBar.style.width = hpPct * 100 + '%';
    this.el.hpText.textContent = Math.round(ship.hp) + ' / ' + ship.maxHp;
    this.el.reloadPort.style.width = reloadPort * 100 + '%';
    this.el.reloadStar.style.width = reloadStar * 100 + '%';
  }

  /**
   * 更新左上角信息面板。
   * @param {object} info
   */
  updateInfo(info) {
    this.el.infoStats.innerHTML =
      'FPS: ' + info.fps + '<br>' +
      '坐标 X: ' + info.x + ' Y: ' + info.y + ' Z: ' + info.z + '<br>' +
      '区块: ' + info.chunkX + ', ' + info.chunkZ + '<br>' +
      '天气: ' + info.weather + '　时段: ' + info.timeLabel + '<br>' +
      '状态: ' + info.status;
  }

  /**
   * 更新 AI 调试面板。
   * @param {Array<{index:number,state:string,hp:number,dist:number,discovered:boolean,alive:boolean}>} states
   */
  updateAI(states) {
    let html = '';
    states.forEach((s) => {
      if (!s.alive) {
        html += '<div class="ai-row">#' + s.index + ' 已击沉</div>';
        return;
      }
      html += '<div class="ai-row">#' + s.index + ' [' + s.state + '] ' +
        'HP ' + s.hp + ' 距离 ' + s.dist +
        (s.discovered ? ' 已发现' : ' 未知') + '</div>';
    });
    this.el.aiStats.innerHTML = html;
  }
}
