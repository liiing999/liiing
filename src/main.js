// main.js —— 游戏入口与主编排：渲染 / 光照 / 天空 / 昼夜 / 天气、
// 固定步长物理循环、输入、区块调度、保存恢复与重置。

import * as THREE from 'three';
import { World, CHUNK_SIZE, WORLD_HALF } from './world.js';
import { Ocean } from './ocean.js';
import { Ship } from './ship.js';
import { EnemyFleet } from './enemy.js';
import { Combat } from './combat.js';
import { CameraRig } from './camera.js';
import { UI } from './ui.js';
import { Minimap } from './minimap.js';
import { saveGame, loadGame, clearSave } from './save.js';
import { getTextures } from './textures.js';

const DEG = Math.PI / 180;
const FIXED_DT = 1 / 60;
const DAY_LENGTH = 150; // 一个完整昼夜周期（秒）

// 三种天气参数：影响波高、风力、能见度与色调
const WEATHERS = {
  clear: { label: '晴', wind: 0.55, wave: 0.5, fogNear: 240, fogFar: 620, tint: new THREE.Color(1.0, 1.0, 1.0) },
  windy: { label: '强风', wind: 0.95, wave: 0.95, fogNear: 170, fogFar: 460, tint: new THREE.Color(0.92, 0.95, 1.0) },
  storm: { label: '暴风雨', wind: 1.0, wave: 1.35, fogNear: 70, fogFar: 260, tint: new THREE.Color(0.55, 0.6, 0.7) }
};
const WEATHER_KEYS = ['clear', 'windy', 'storm'];

/** 判断是否为移动端（仅给出提示，桌面端完整可玩）。 */
function isMobileDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/**
 * 天空系统：渐变背景着色器、太阳 / 月亮、星星、程序化云片与暴风雨雨线。
 */
class SkySystem {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;

    // 大球体天壳，内侧渲染渐变
    const geo = new THREE.SphereGeometry(1600, 24, 16);
    this.uniforms = {
      uTop: { value: new THREE.Color(0.27, 0.55, 0.92) },
      uBottom: { value: new THREE.Color(0.78, 0.9, 1.0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: [
        'varying vec3 vDir;',
        'void main(){',
        '  vDir = normalize(position);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uSunDir;',
        'varying vec3 vDir;',
        'void main(){',
        '  float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);',
        '  vec3 col = mix(uBottom, uTop, pow(h, 0.8));',
        '  float sunGlow = pow(max(dot(normalize(vDir), normalize(uSunDir)), 0.0), 64.0);',
        '  col += vec3(1.0,0.85,0.55) * sunGlow * 0.5;',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n')
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = -1;
    scene.add(this.mesh);

    // 太阳与月亮（发光盘）
    this.sun = new THREE.Mesh(
      new THREE.CircleGeometry(42, 18),
      new THREE.MeshBasicMaterial({ color: 0xfff2c0, fog: false, depthWrite: false })
    );
    this.moon = new THREE.Mesh(
      new THREE.CircleGeometry(30, 18),
      new THREE.MeshBasicMaterial({ color: 0xdfe8ff, fog: false, depthWrite: false })
    );
    scene.add(this.sun, this.moon);

    // 星星（夜晚可见）
    const starCount = 220;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3(
        Math.random() * 2 - 1, Math.random() * 0.9 + 0.05, Math.random() * 2 - 1
      ).normalize().multiplyScalar(1400);
      starPos[i * 3] = v.x;
      starPos[i * 3 + 1] = v.y;
      starPos[i * 3 + 2] = v.z;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xffffff, size: 3, sizeAttenuation: false, transparent: true,
      opacity: 0, fog: false, depthWrite: false
    }));
    scene.add(this.stars);

    // 程序化云片（固定对象池）
    const tex = getTextures().cloud;
    this.clouds = [];
    for (let i = 0; i < 22; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0.8, depthWrite: false, fog: false
      }));
      const angle = Math.random() * Math.PI * 2;
      const radius = 300 + Math.random() * 700;
      const cloud = {
        sprite,
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
        y: 190 + Math.random() * 120,
        scale: 130 + Math.random() * 160,
        speed: 4 + Math.random() * 6
      };
      sprite.position.set(cloud.x, cloud.y, cloud.z);
      sprite.scale.setScalar(cloud.scale);
      this.clouds.push(cloud);
      scene.add(sprite);
    }

    // 暴风雨雨线（Points 下落）
    const rainCount = 600;
    const rainPos = new Float32Array(rainCount * 3);
    this._rainData = [];
    for (let i = 0; i < rainCount; i++) {
      const x = (Math.random() * 2 - 1) * 90;
      const y = Math.random() * 60;
      const z = (Math.random() * 2 - 1) * 90;
      rainPos[i * 3] = x;
      rainPos[i * 3 + 1] = y;
      rainPos[i * 3 + 2] = z;
      this._rainData.push({ x, y, z });
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    this.rain = new THREE.Points(rainGeo, new THREE.PointsMaterial({
      color: 0xaecbe0, size: 2, transparent: true, opacity: 0.6, depthWrite: false
    }));
    this.rain.visible = false;
    scene.add(this.rain);
  }

  /**
   * 更新天空颜色、日月位置、云移动与雨。
   * @param {number} time
   * @param {THREE.Vector3} sunDir
   * @param {THREE.Color} topColor
   * @param {THREE.Color} bottomColor
   * @param {number} weatherStrength
   * @param {THREE.Vector3} center
   * @param {number} windAngle
   */
  update(time, sunDir, topColor, bottomColor, weatherStrength, center, windAngle) {
    this.mesh.position.copy(center);
    this.uniforms.uTop.value.copy(topColor);
    this.uniforms.uBottom.value.copy(bottomColor);
    this.uniforms.uSunDir.value.copy(sunDir);

    // 太阳 / 月亮放到天壳上并朝向相机
    const sunPos = sunDir.clone().multiplyScalar(1300).add(center);
    this.sun.position.copy(sunPos);
    this.sun.lookAt(center);
    const moonPos = sunDir.clone().multiplyScalar(-1300).add(center);
    this.moon.position.copy(moonPos);
    this.moon.lookAt(center);
    this.sun.visible = sunDir.y > -0.1;
    this.moon.visible = sunDir.y < 0.15;

    // 星星仅夜晚可见
    this.stars.position.copy(center);
    this.stars.material.opacity = THREE.MathUtils.clamp(-sunDir.y * 2.2, 0, 0.9);

    // 云随风移动并环绕玩家
    const windVx = Math.sin(windAngle + Math.PI);
    const windVz = Math.cos(windAngle + Math.PI);
    for (const cloud of this.clouds) {
      cloud.x += windVx * cloud.speed * 0.016;
      cloud.z += windVz * cloud.speed * 0.016;
      let dx = cloud.x - center.x;
      let dz = cloud.z - center.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 900) {
        cloud.x = center.x - windVx * 800 + (Math.random() - 0.5) * 300;
        cloud.z = center.z - windVz * 800 + (Math.random() - 0.5) * 300;
        dx = cloud.x - center.x;
        dz = cloud.z - center.z;
      }
      cloud.sprite.position.set(center.x + dx, cloud.y, center.z + dz);
      cloud.sprite.material.opacity = 0.85 - weatherStrength * 0.45;
    }

    // 雨仅在暴风雨可见，跟随玩家下落
    this.rain.visible = weatherStrength > 0.55;
    if (this.rain.visible) {
      this.rain.position.set(center.x, 0, center.z);
      const posAttr = this.rain.geometry.attributes.position;
      for (let i = 0; i < this._rainData.length; i++) {
        const d = this._rainData[i];
        d.y -= 40 * 0.016;
        d.x += windVx * 6 * 0.016;
        if (d.y < 0) {
          d.y = 55;
          d.x = (Math.random() * 2 - 1) * 90;
          d.z = (Math.random() * 2 - 1) * 90;
        }
        posAttr.setXYZ(i, d.x, d.y, d.z);
      }
      posAttr.needsUpdate = true;
    }
  }
}

/**
 * 游戏主控。
 */
class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.running = false;
    this.paused = true;
    this.debugVisible = false;
    this.mode = 'start';

    // 渲染器
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      60, window.innerWidth / window.innerHeight, 0.5, 2200
    );
    this.camera.position.set(0, 10, -20);

    // 灯光：半球光 + 环境光 + 方向光（太阳）
    this.hemi = new THREE.HemisphereLight(0xbfe3ff, 0x35503a, 0.9);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.25);
    this.sunLight = new THREE.DirectionalLight(0xfff1d0, 1.2);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    const sc = this.sunLight.shadow.camera;
    sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60;
    sc.near = 1; sc.far = 260;
    this.sunLight.target = new THREE.Object3D();
    this.scene.add(this.hemi, this.ambient, this.sunLight, this.sunLight.target);

    // 距离雾
    this.scene.fog = new THREE.Fog(0x9fc4dd, 240, 620);

    // 默认设置
    this.settings = {
      viewDistance: 4,
      sensitivity: 1.0,
      quality: 'medium'
    };

    // 时间与天气
    this.elapsed = 0;
    this.dayT = 0.32; // 从早晨开始
    this.weatherIndex = 0;
    this.weather = WEATHERS.clear;
    this.weatherTimer = 35;
    this.windAngle = 45 * DEG;

    // 复用临时颜色
    this._sunDir = new THREE.Vector3();
    this._skyTop = new THREE.Color();
    this._skyBottom = new THREE.Color();
    this._sunColor = new THREE.Color();
    this._tint = new THREE.Color(1, 1, 1);
    this._fogNear = 240;
    this._fogFar = 620;

    // 战局状态
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.sunkCount = 0;
    this.mappedIslands = new Set();

    // 输入
    this.keys = {};
    this.pointerLocked = false;
    this._spyHeld = false;

    // 计时统计
    this.fps = 60;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._hudAccum = 0;
    this._saveAccum = 0;
    this._accumulator = 0;
    this._lastTime = 0;

    this._buildUI();
    this._bindInput();

    window.addEventListener('resize', () => this._onResize());
  }

  /** 创建 UI 与菜单回调。 */
  _buildUI() {
    this.ui = new UI({
      onStart: (opts) => this.startGame(opts),
      onResume: () => this.resume(),
      onSave: () => this.save(),
      onReset: (newSeed) => this.resetWorld(newSeed),
      onSettings: (s) => this.applySettings(s, true)
    });
    this.ui.initSettings(this.settings);
  }

  /** 首次进入流程：检测存档与移动端。 */
  boot() {
    if (isMobileDevice()) {
      this.ui.showScreen('mobile', true);
    } else {
      const save = loadGame();
      if (save) this.ui.setStartHint('检测到上次航行存档，点击「起锚出航」继续探索。');
      this.ui.showScreen('start', true);
    }
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame((t) => this._frame(t));
  }

  /**
   * 根据种子 / 存档构建整个世界。
   * @param {object} save
   * @param {number} difficulty
   */
  _buildWorld(save, difficulty) {
    this.seed = save.seed >>> 0;
    this.world = new World(this.scene, this.seed, { quality: this.settings.quality });
    this.world.viewRadius = this.settings.viewDistance;
    this.ocean = new Ocean(this.scene, this.world);
    this.ocean.time = 0;
    this.player = new Ship(this.scene, { isEnemy: false });
    this.enemies = new EnemyFleet(this.scene, this.seed ^ 0x9e37, difficulty, this.world);
    this.combat = new Combat(this.scene);
    this.sky = new SkySystem(this.scene);
    this.cameraRig = new CameraRig(this.camera, this.world, this.ocean);
    this.cameraRig.sensitivity = this.settings.sensitivity;
    this.minimap = new Minimap(document.getElementById('minimap'), this.world);

    this._applyQuality();

    // 恢复船只与战局；新船默认朝顺风方向出生
    if (save.player) this.player.deserialize(save.player);
    else this.player.resetState(0, 40, this.windAngle + Math.PI);
    this.enemies.restoreState(save.sunkEnemies, save.discoveredEnemies);
    this.sunkCount = (save.sunkEnemies || []).length;
    this.mappedIslands = new Set(save.mappedIslands || []);
    if (typeof save.dayT === 'number') this.dayT = save.dayT;
    if (typeof save.weatherIndex === 'number') {
      this.weatherIndex = save.weatherIndex;
      this.weather = WEATHERS[WEATHER_KEYS[this.weatherIndex]];
    }

    // 出生安全修正：避免恢复时船卡在岛内
    this._ensureSafeSpawn(this.player);

    // 战斗事件
    this.combat.onSunk = (target, faction) => {
      if (target.isEnemy) {
        this.sunkCount += 1;
        this.ui.toast('击沉一艘海盗船！ 总战绩 ' + this.sunkCount);
      } else {
        this._onPlayerSunk();
      }
    };

    // 预先加载玩家周围区块
    for (let i = 0; i < 60; i++) {
      if (this.world.update(this.player.position.x, this.player.position.z, 6) === 0) break;
    }
  }

  /**
   * 若船当前在陆地 / 浅滩，螺旋搜索最近深水点。
   * @param {Ship} ship
   */
  _ensureSafeSpawn(ship) {
    if (this.world.getHeight(ship.position.x, ship.position.z) < -2.5) return;
    for (let radius = 20; radius <= 300; radius += 20) {
      for (let a = 0; a < Math.PI * 2; a += 0.4) {
        const x = ship.position.x + Math.sin(a) * radius;
        const z = ship.position.z + Math.cos(a) * radius;
        if (this.world.getHeight(x, z) < -3) {
          ship.position.set(x, 0, z);
          ship.vel.set(0, 0);
          return;
        }
      }
    }
    ship.resetState(0, 40, 0);
  }

  /**
   * 从开始界面启动游戏（新游戏或读档）。
   * @param {{difficulty:number, newSeed:boolean}} opts
   */
  startGame(opts) {
    let save = loadGame();
    const needNewSeed = opts.newSeed || !save;
    if (needNewSeed) {
      save = {
        seed: ((Math.random() * 0xffffffff) >>> 0),
        difficulty: opts.difficulty,
        settings: { ...this.settings },
        player: null,
        sunkEnemies: [],
        discoveredEnemies: [],
        mappedIslands: [],
        dayT: 0.32,
        weatherIndex: 0
      };
    }
    if (save.settings) {
      this.settings = { ...this.settings, ...save.settings };
      this.ui.initSettings(this.settings);
    }
    save.difficulty = save.difficulty || opts.difficulty;

    this._buildWorld(save, save.difficulty);
    this.mode = 'playing';
    this.paused = false;
    this.running = true;
    this.ui.showScreen('start', false);
    this.ui.showScreen('hud', true);
    this.ui.showScreen('info', true);
    this.ui.toast('起锚！用 W 升帆，顺着风向航行');
    this._requestPointerLock();
  }

  /** 继续游戏。 */
  resume() {
    this.paused = false;
    this.mode = 'playing';
    this.ui.showScreen('pause', false);
    this._requestPointerLock();
  }

  /**
   * 应用设置（视距 / 灵敏度 / 画质）。
   * @param {object} s
   * @param {boolean} live 是否在游戏中实时应用
   */
  applySettings(s, live = false) {
    this.settings = { ...this.settings, ...s };
    if (this.cameraRig) this.cameraRig.sensitivity = this.settings.sensitivity;
    if (this.world) this.world.viewRadius = this.settings.viewDistance;
    if (live && this.world) this._applyQuality();
  }

  /** 按画质档位调整像素比、阴影、植被密度（密度改变需重建区块）。 */
  _applyQuality() {
    const q = this.settings.quality;
    this.renderer.shadowMap.enabled = q === 'high';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.sunLight.castShadow = q === 'high';
    this.renderer.setPixelRatio(q === 'low' ? 1 : Math.min(window.devicePixelRatio, 1.5));
    if (this.world) {
      const density = q === 'high' ? 1.0 : q === 'low' ? 0.35 : 0.65;
      const perChunk = q === 'high' ? 26 : q === 'low' ? 8 : 16;
      const changed = this.world.treeDensity !== density;
      this.world.treeDensity = density;
      this.world.treesPerChunk = perChunk;
      this.world.quality = q;
      if (changed) this._reloadChunks();
    }
  }

  /** 强制重新加载所有区块（改变植被密度时）。 */
  _reloadChunks() {
    for (const [key, chunk] of Array.from(this.world.chunks)) {
      this.scene.remove(chunk.group);
      chunk.geometry.dispose();
      this.world.chunks.delete(key);
    }
  }

  /**
   * 重置世界：清存档并重新生成，可保留 / 更换种子。
   * @param {boolean} newSeed
   */
  resetWorld(newSeed) {
    const old = loadGame();
    clearSave();
    this._teardownWorld();
    const seed = newSeed
      ? ((Math.random() * 0xffffffff) >>> 0)
      : ((old && old.seed) >>> 0) || ((Math.random() * 0xffffffff) >>> 0);
    const difficulty = old ? (old.difficulty || 5) : 5;
    const save = {
      seed, difficulty,
      settings: { ...this.settings },
      player: null,
      sunkEnemies: [], discoveredEnemies: [], mappedIslands: [],
      dayT: 0.32, weatherIndex: 0
    };
    this._buildWorld(save, difficulty);
    this.mode = 'playing';
    this.paused = false;
    this.ui.showScreen('pause', false);
    this.ui.showScreen('hud', true);
    this.ui.showScreen('info', true);
    this.ui.toast(newSeed ? '已用新种子重新生成世界' : '已用相同种子重置世界');
    this.save();
    this._requestPointerLock();
  }

  /** 拆除当前世界所有对象，释放显存。 */
  _teardownWorld() {
    this.enemies.dispose();
    this.player.dispose();
    this.combat.dispose();
    this.ocean.dispose();
    this.world.dispose();
    this.scene.remove(this.sky.mesh, this.sky.sun, this.sky.moon, this.sky.stars, this.sky.rain);
    for (const cloud of this.sky.clouds) this.scene.remove(cloud.sprite);
    this.sunkCount = 0;
    this.mappedIslands = new Set();
  }

  /** 序列化并保存当前世界。 */
  save() {
    if (!this.world || !this.player) return false;
    return saveGame({
      seed: this.seed,
      difficulty: this.enemies.enemies.length,
      player: this.player.serialize(),
      sunkEnemies: this.enemies.sunkIndices,
      discoveredEnemies: this.enemies.discoveredIndices,
      mappedIslands: Array.from(this.mappedIslands),
      dayT: this.dayT,
      weatherIndex: this.weatherIndex,
      settings: { ...this.settings }
    });
  }

  /** 请求指针锁定（鼠标环绕视角）。 */
  _requestPointerLock() {
    const el = this.canvas;
    if (el.requestPointerLock) {
      const result = el.requestPointerLock();
      if (result && result.catch) result.catch(() => { /* 无头环境或无手势时忽略 */ });
    }
  }

  /** 打开暂停菜单并保存一次。 */
  _openPause() {
    this.paused = true;
    this.mode = 'paused';
    this.ui.showScreen('pause', true);
    this.save();
  }

  /** 调试键切换天气。 */
  _cycleWeather(dir) {
    this.weatherIndex = (this.weatherIndex + dir + WEATHER_KEYS.length) % WEATHER_KEYS.length;
    this.weather = WEATHERS[WEATHER_KEYS[this.weatherIndex]];
    this.weatherTimer = 30;
    this.ui.toast('天气：' + this.weather.label);
  }

  /** 绑定键盘 / 鼠标输入。 */
  _bindInput() {
    window.addEventListener('keydown', (ev) => {
      this.keys[ev.code] = true;
      if (ev.code === 'F3') {
        ev.preventDefault();
        this.debugVisible = !this.debugVisible;
        this.ui.setDebugVisible(this.debugVisible);
      }
      if (!this.running || this.paused) return;
      if (ev.code === 'Space') {
        ev.preventDefault();
        this.player.toggleAnchor();
        this.ui.toast(this.player.anchored ? '已抛锚' : '起锚');
      }
      if (ev.code === 'KeyV') {
        this.cameraRig.toggleMode();
        this.ui.toast(this.cameraRig.mode === 'first' ? '第一人称视角' : '第三人称视角');
      }
      if (ev.code === 'BracketLeft') this._cycleWeather(-1);
      if (ev.code === 'BracketRight') this._cycleWeather(1);
      if (ev.code === 'Minus') this.dayT = (this.dayT - 0.05 + 1) % 1;
      if (ev.code === 'Equal') this.dayT = (this.dayT + 0.05) % 1;
      if (ev.code === 'KeyZ' && !this._spyHeld) {
        this._spyHeld = true;
        this.cameraRig.setSpyglass(true);
        this.ui.setSpyglass(true);
      }
    });

    window.addEventListener('keyup', (ev) => {
      this.keys[ev.code] = false;
      if (ev.code === 'KeyZ' && this.cameraRig) {
        this._spyHeld = false;
        this.cameraRig.setSpyglass(false);
        this.ui.setSpyglass(false);
      }
    });

    // 指针锁定变化 -> 暂停 / 恢复
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked && this.running && !this.paused) this._openPause();
    });

    document.addEventListener('mousemove', (ev) => {
      if (this.pointerLocked && this.cameraRig && !this.paused) {
        this.cameraRig.addLook(ev.movementX, ev.movementY);
      }
    });

    window.addEventListener('wheel', (ev) => {
      if (this.pointerLocked && this.cameraRig) this.cameraRig.zoom(ev.deltaY);
    }, { passive: true });

    // 火炮：左键左舷，右键右舷
    this.canvas.addEventListener('mousedown', (ev) => {
      if (!this.running || this.paused || !this.pointerLocked) return;
      const side = ev.button === 0 ? 'port' : ev.button === 2 ? 'star' : null;
      if (!side) return;
      if (this.player.requestBroadside(side, this.elapsed)) {
        this.combat.fireBroadside(this.player, side);
      }
    });
    this.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  /**
   * 更新昼夜光照 / 天空颜色 / 雾色与天气（平滑过渡）。
   * @param {number} dt
   */
  _updateEnvironment(dt) {
    this.dayT = (this.dayT + dt / DAY_LENGTH) % 1;

    // 太阳轨迹：dayT=0 午夜，0.25 日出，0.5 正午，0.75 日落
    const sunAngle = (this.dayT - 0.25) * Math.PI * 2;
    this._sunDir.set(Math.cos(sunAngle) * 0.35, Math.sin(sunAngle), 0.8).normalize();
    const sunHeight = THREE.MathUtils.clamp(this._sunDir.y, -0.25, 1);
    const dayFactor = THREE.MathUtils.clamp(sunHeight * 2.2 + 0.25, 0, 1);

    // 天空渐变：夜晚深蓝 → 日出橙 → 白天蓝
    const nightTop = new THREE.Color(0.04, 0.06, 0.16);
    const dayTop = new THREE.Color(0.27, 0.55, 0.92);
    const duskTop = new THREE.Color(0.35, 0.3, 0.55);
    this._skyTop.copy(nightTop).lerp(dayTop, dayFactor);
    const duskFactor = Math.max(0, 1 - Math.abs(sunHeight) * 4);
    this._skyTop.lerp(duskTop, duskFactor * 0.4 * dayFactor);

    const nightBottom = new THREE.Color(0.1, 0.12, 0.22);
    const dayBottom = new THREE.Color(0.78, 0.9, 1.0);
    this._skyBottom.copy(nightBottom).lerp(dayBottom, dayFactor);

    // 太阳光强度与颜色
    this._sunColor.set(1.0, 0.95, 0.8).lerp(new THREE.Color(1.0, 0.6, 0.35), duskFactor * 0.6);
    this.sunLight.color.copy(this._sunColor);
    this.sunLight.intensity = 0.15 + dayFactor * 1.15;
    this.sunLight.position.copy(this._sunDir).multiplyScalar(120).add(this.player.position);
    this.sunLight.target.position.copy(this.player.position);
    this.hemi.intensity = 0.25 + dayFactor * 0.65;
    this.ambient.intensity = 0.12 + dayFactor * 0.2;

    // 天气自动轮换
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      this.weatherIndex = (this.weatherIndex + 1) % WEATHER_KEYS.length;
      this.weather = WEATHERS[WEATHER_KEYS[this.weatherIndex]];
      this.weatherTimer = 35 + Math.random() * 25;
    }

    // 天气参数平滑过渡
    this._tint.lerp(this.weather.tint, dt * 0.5);
    this._fogNear += (this.weather.fogNear - this._fogNear) * dt * 0.5;
    this._fogFar += (this.weather.fogFar - this._fogFar) * dt * 0.5;

    const fogColor = this._skyBottom.clone().multiply(this._tint);
    this.scene.fog.color.copy(fogColor);
    this.scene.fog.near = this._fogNear;
    this.scene.fog.far = this._fogFar;

    // 风向缓慢变化，风力取自天气
    this.windAngle += Math.sin(this.elapsed * 0.05) * dt * 0.02;
    const windStrength = this.weather.wind;
    this.player.setWind(this.windAngle, windStrength);
    this.enemies.setWind(this.windAngle, windStrength);
    this.ocean.setWind(this.windAngle, windStrength, this.weather.wave);

    this.ocean.update(
      this.elapsed, this._sunDir, this._sunColor,
      this._skyBottom, this.scene.fog.color,
      { near: this._fogNear, far: this._fogFar }, this._tint
    );
    const weatherStrength = WEATHER_KEYS[this.weatherIndex] === 'storm'
      ? 1
      : WEATHER_KEYS[this.weatherIndex] === 'windy' ? 0.4 : 0.1;
    this.sky.update(
      this.elapsed, this._sunDir, this._skyTop, this._skyBottom,
      weatherStrength, this.player.position, this.windAngle
    );
    this.world.updateWind(this.elapsed, windStrength);
  }

  /** 当前时段中文标签。 */
  _timeLabel() {
    if (this.dayT < 0.21 || this.dayT > 0.80) return '夜晚';
    if (this.dayT < 0.32) return '清晨';
    if (this.dayT < 0.7) return '白天';
    return '黄昏';
  }

  /**
   * 固定步长物理 / 逻辑子步。
   * @param {number} dt
   */
  _fixedUpdate(dt) {
    this._updateEnvironment(dt);

    // 玩家操控输入 -> 船只
    let rudder = 0;
    if (this.keys['KeyA']) rudder -= 1;
    if (this.keys['KeyD']) rudder += 1;
    this.player.setRudderInput(rudder, dt);
    if (this.keys['KeyW']) this.player.raiseSail(dt);
    if (this.keys['KeyS']) this.player.lowerSail(dt);
    if (this.keys['KeyQ']) this.player.trimYard(-1, dt);
    if (this.keys['KeyE']) this.player.trimYard(1, dt);

    this.player.update(dt, this.ocean, this.world);

    // 敌船 AI
    this.enemies.update(dt, this.player, this.ocean, this.world, {
      spyglass: this.cameraRig.spyglass,
      onDiscover: () => this.ui.toast('发现一艘海盗船！')
    });

    // 执行 AI 请求的齐射
    for (const req of this.enemies.pendingFires) {
      this.combat.fireBroadside(req.ship, req.side);
    }

    // 炮弹与特效（玩家与所有海盗互为目标）
    this.combat.update(dt, this.ocean, this.world, [this.player, ...this.enemies.ships]);

    // 受损船只持续冒烟
    if (this.player.hp < this.player.maxHp * 0.66) this.combat.emitDamageSmoke(this.player, dt);
    for (const enemy of this.enemies.enemies) {
      if (enemy.ship.alive && enemy.ship.hp < enemy.ship.maxHp * 0.66) {
        this.combat.emitDamageSmoke(enemy.ship, dt);
      }
    }

    this.ocean.setCenter(this.player.position.x, this.player.position.z);
    this.world.update(this.player.position.x, this.player.position.z, 1);
    this._updateMapping();
  }

  /** 玩家靠近岛屿时自动标记为已测绘。 */
  _updateMapping() {
    for (let i = 0; i < this.world.islands.length; i++) {
      if (this.mappedIslands.has(i)) continue;
      const isl = this.world.islands[i];
      const d = Math.hypot(this.player.position.x - isl.x, this.player.position.z - isl.z);
      if (d < isl.radius + 42) {
        this.mappedIslands.add(i);
        this.ui.toast('已测绘一座岛屿（' + this.mappedIslands.size + '）');
      }
    }
  }

  /** 玩家沉没：提示后在安全水域重生。 */
  _onPlayerSunk() {
    this.ui.showScreen('sunk', true);
    setTimeout(() => this.ui.showScreen('sunk', false), 2200);
    const s = this.player;
    s.resetState(s.position.x, s.position.z, s.heading, s.maxHp);
    this._ensureSafeSpawn(s);
    for (const enemy of this.enemies.enemies) {
      if (!enemy.ship.alive) continue;
      const d = Math.hypot(s.position.x - enemy.ship.position.x, s.position.z - enemy.ship.position.z);
      if (d < 120) {
        s.resetState(0, 40, 0, s.maxHp);
        break;
      }
    }
    this.ui.toast('在安全水域重生');
  }

  /**
   * 主循环：rAF + 固定步长物理子步。
   * @param {number} timestamp
   */
  _frame(timestamp) {
    requestAnimationFrame((t) => this._frame(t));
    if (!this._lastTime) this._lastTime = timestamp;
    let frameDt = (timestamp - this._lastTime) / 1000;
    this._lastTime = timestamp;
    frameDt = Math.min(frameDt, 0.1); // 防止切后台后大步长

    this._fpsAccum += frameDt;
    this._fpsFrames++;

    if (this.running && !this.paused) {
      this.elapsed += frameDt;
      this.ocean.time = this.elapsed;

      this._accumulator += frameDt;
      let steps = 0;
      while (this._accumulator >= FIXED_DT && steps < 5) {
        this._fixedUpdate(FIXED_DT);
        this._accumulator -= FIXED_DT;
        steps++;
      }

      this.cameraRig.update(frameDt, this.player);
      this.renderer.render(this.scene, this.camera);

      this._hudAccum += frameDt;
      if (this._hudAccum >= 0.1) {
        this._hudAccum = 0;
        this._refreshHUD();
      }

      this._saveAccum += frameDt;
      if (this._saveAccum >= 12) {
        this._saveAccum = 0;
        this.save();
      }
    } else if (this.scene) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** 刷新全部 HUD / 调试数值。 */
  _refreshHUD() {
    if (this._fpsAccum >= 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsAccum);
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    const p = this.player;
    const terrainH = this.world.getHeight(p.position.x, p.position.z);
    const waterH = this.ocean.getHeightAt(p.position.x, p.position.z, this.elapsed);
    const depth = terrainH < 0 ? waterH - terrainH : 0;

    this.ui.drawCompass(p.heading, this.windAngle, p.sailEfficiency);
    this.ui.updateHud(
      p, depth,
      1 - Math.max(0, p.reloadPort) / 5,
      1 - Math.max(0, p.reloadStar) / 5
    );
    this.minimap.draw(
      p,
      this.enemies.enemies.map((e) => ({ ship: e.ship, discovered: e.discovered })),
      this.mappedIslands
    );

    const chunkX = Math.floor((p.position.x + WORLD_HALF) / CHUNK_SIZE);
    const chunkZ = Math.floor((p.position.z + WORLD_HALF) / CHUNK_SIZE);
    const status = [
      p.anchored ? '抛锚' : '航行',
      this.cameraRig.mode === 'first' ? '第一人称' : '',
      this.cameraRig.spyglass ? '望远镜' : ''
    ].filter(Boolean).join(' / ');

    this.ui.updateInfo({
      fps: this.fps,
      x: p.position.x.toFixed(1),
      y: waterH.toFixed(1),
      z: p.position.z.toFixed(1),
      chunkX, chunkZ,
      weather: this.weather.label,
      timeLabel: this._timeLabel(),
      status
    });

    if (this.debugVisible) {
      this.ui.updateAI(this.enemies.getDebugStates(p));
      this._appendRenderStats();
    }
  }

  /** 在调试信息里附加 draw call / 三角形 / 堆占用 / 区块数。 */
  _appendRenderStats() {
    const info = this.renderer.info;
    const mem = performance.memory
      ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + ' MB'
      : '不可用';
    const el = this.ui.el.infoStats;
    el.innerHTML +=
      '<br>区块数量: ' + this.world.chunkCount +
      '<br>Draw calls: ' + info.render.calls +
      '<br>三角形: ' + info.render.triangles +
      '<br>JS 堆: ' + mem;
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

// 启动游戏；暴露到 window 便于在浏览器控制台调试
const game = new Game();
window.__game = game;
game.boot();
