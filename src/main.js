// ============================================================
// main.js —— 游戏入口与总编排
//  渲染器 / 天空昼夜 / 天气与风 / 固定步长物理子步 /
//  输入 / 相机 / 战斗 / AI / 发现与测绘 / 存档 / 菜单
// ============================================================
import * as THREE from "three";
import { World, ChunkManager, CHUNK_SIZE, windUniforms } from "./world.js";
import { Ocean, waveHeight } from "./ocean.js";
import { Ship, createShipTextures } from "./ship.js";
import { EnemyManager } from "./enemy.js";
import { CombatSystem } from "./combat.js";
import { CameraRig } from "./camera.js";
import { UI } from "./ui.js";
import { Minimap } from "./minimap.js";
import {
  DEFAULT_SETTINGS,
  QUALITY_PRESETS,
  hasSave,
  loadGame,
  saveGame,
  clearSave,
  describeSave,
  isMobileDevice,
} from "./save.js";
import { makeCloudTexture, makeSmokeTexture, makeFoamTexture, makeFlashTexture } from "./textures.js";

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 4;

// ---------------- 天气定义 ----------------
// wind：推力强度；wave：波高系数；fogNear/far：能见度
const WEATHERS = [
  {
    key: "clear", name: "晴",
    wind: 1.0, wave: 1.0,
    fogNear: 200, fogFar: 620,
    fogColor: 0xbcd7e8,
    shallowColor: 0x35a08a, deepColor: 0x0e3d63,
    hemiSky: 0xbfdfff, hemiGround: 0x5a6e52,
    rain: 0, cloud: 0.55,
  },
  {
    key: "windy", name: "强风",
    wind: 1.6, wave: 1.55,
    fogNear: 120, fogFar: 430,
    fogColor: 0xa9bdc9,
    shallowColor: 0x2f8f86, deepColor: 0x0c3557,
    hemiSky: 0xadcbdf, hemiGround: 0x54624d,
    rain: 0, cloud: 0.85,
  },
  {
    key: "storm", name: "暴风雨",
    wind: 2.1, wave: 2.15,
    fogNear: 60, fogFar: 250,
    fogColor: 0x6a7783,
    shallowColor: 0x2c6f70, deepColor: 0x0a283f,
    hemiSky: 0x7d8c99, hemiGround: 0x414a44,
    rain: 1, cloud: 1,
  },
];

const TIME_LABELS = [
  [0.0, "深夜"], [0.22, "黎明"], [0.30, "清晨"], [0.45, "正午"],
  [0.70, "黄昏"], [0.80, "傍晚"], [0.90, "夜晚"],
];

function timeLabel(t) {
  let label = TIME_LABELS[0][1];
  for (const [start, name] of TIME_LABELS) if (t >= start) label = name;
  return label;
}

// 平滑工具
function damp(a, b, lambda, dt) {
  return THREE.MathUtils.lerp(a, b, 1 - Math.exp(-lambda * dt));
}

// ============================================================
// Game
// ============================================================
class Game {
  constructor() {
    this.running = false;
    this.paused = true;
    this.settings = Object.assign({}, DEFAULT_SETTINGS);

    this._initRenderer();
    this.ui = new UI();

    // 输入状态
    this.keys = {};
    this.pointerLocked = false;
    this.mouseDown = { 0: false, 2: false };
    this.mappedIslands = new Set();

    // 时间
    this.clock = new THREE.Clock();
    this.accumulator = 0;
    this.fpsSmooth = 60;

    // 天气 / 昼夜
    this.weatherIndex = 0;
    this.weatherTimer = 25 + Math.random() * 20;
    this.dayTime = 0.35;            // 0~1
    this.dayLength = 240;           // 一昼夜秒数
    this.windAngle = Math.random() * Math.PI * 2;

    // 事件提示节流
    this._groundWarn = 0;
    this._prevHp = 100;
    this.autosaveTimer = 0;

    this._bindGlobalInput();
    this._bindMenus();
  }

  // ----------------------------------------------------------
  // 渲染器 / 场景基础
  // ----------------------------------------------------------
  _initRenderer() {
    this.app = document.getElementById("app");
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.app.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1800);
    this.camera.position.set(0, 10, -14);

    this.fog = new THREE.Fog(0xbcd7e8, 200, 620);
    this.scene.fog = this.fog;

    // 半球光 + 环境 + 方向光（太阳）
    this.hemi = new THREE.HemisphereLight(0xbfdfff, 0x5a6e52, 0.9);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.18);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff2d0, 1.4);
    this.sun.position.set(60, 120, 40);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.near = 10;
    sc.far = 420;
    sc.left = -90;
    sc.right = 90;
    sc.top = 90;
    sc.bottom = -90;
    this.sun.shadow.bias = -0.0008;
    // 月亮（弱冷光，方向与太阳相反）
    this.moon = new THREE.DirectionalLight(0x9fc2ff, 0.0);
    this.scene.add(this.moon);
    this.scene.add(this.moon.target);

    this.renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("resize", () => this._onResize());
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ----------------------------------------------------------
  // 新建 / 加载世界
  // ----------------------------------------------------------
  newSeedString() {
    return "arch-" + Math.floor(Math.random() * 1e9).toString(36) + Date.now().toString(36);
  }

  /** 按种子建立整套世界对象 */
  buildWorld(seedString, settings, saved = null) {
    this.teardownWorld();

    const seedHash = hashString(seedString);
    this.seedString = seedString;
    this.world = new World(seedHash);

    const quality = QUALITY_PRESETS[settings.quality] || QUALITY_PRESETS.medium;
    this.quality = quality;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.chunks = new ChunkManager(this.scene, this.world, quality);
    this.chunks.setViewRadius(settings.viewDistance);

    this.ocean = new Ocean(this.world, quality);
    this.scene.add(this.ocean.mesh);

    const shipTex = createShipTextures();
    this.textures = {
      sail: shipTex.sail,
      wood: shipTex.wood,
      flag: shipTex.flag,
      pirateFlag: shipTex.pirateFlag,
      compass: shipTex.compass,
      foam: makeFoamTexture(),
      smoke: makeSmokeTexture(),
      flash: makeFlashTexture(),
    };

    // 玩家船
    this.ship = new Ship(this.world, this.textures);
    const spawn = this.world.findSafePosition(0, 0);
    this.ship.setTransform(spawn.x, spawn.z, spawn.heading);
    this.scene.add(this.ship.group);

    // 海盗
    this.enemies = new EnemyManager(this.world, this.scene, this.textures);
    this.enemies.spawn(spawn.x, spawn.z, saved ? saved.enemyData : null);
    if (saved && saved.discoveredData) this.enemies.deserialize(saved.discoveredData);

    // 战斗
    this.combat = new CombatSystem(this.scene, this.world, this.textures);

    // 相机
    this.cameraRig = new CameraRig(this.camera, this.world, settings);

    // 小地图
    this.minimap = new Minimap(this.ui.minimapCanvas, this.world);

    // 恢复存档状态；若存档点已不安全（卡在陆地 / 浅滩），迁移到附近深水
    if (saved && saved.ship) {
      this.ship.deserialize(saved.ship);
      const depthHere = this.world.depthAt(this.ship.position.x, this.ship.position.z);
      const stuck =
        depthHere < 6 ||
        this.world.outsideWorld(this.ship.position.x, this.ship.position.z, 20);
      if (stuck) {
        const safe = this.world.findSafePosition(this.ship.position.x, this.ship.position.z, 10, 15);
        this.ship.setTransform(safe.x, safe.z, saved.ship.heading);
      }
    }
    if (saved && saved.mappedIslands) this.mappedIslands = new Set(saved.mappedIslands);
    else this.mappedIslands = new Set();
    if (saved && typeof saved.dayTime === "number") this.dayTime = saved.dayTime;
    if (saved && typeof saved.weatherIndex === "number") this.weatherIndex = saved.weatherIndex;

    // 天空 / 云 / 雨
    this._buildSky();
    this._buildClouds();
    this._buildRain();

    // 让出生区域立即出现（同步生成若干块）
    this.chunks.update(this.ship.position.x, this.ship.position.z, 999);
  }

  /** 退出 / 重置时释放当前世界资源 */
  teardownWorld() {
    if (!this.world) return;
    if (this.chunks) { this.chunks.disposeAll(); this.chunks = null; }
    if (this.ocean) { this.scene.remove(this.ocean.mesh); this.ocean.dispose(); this.ocean = null; }
    if (this.combat) { this.combat.dispose(); this.combat = null; }
    if (this.enemies) { this.enemies.dispose(); this.enemies = null; }
    if (this.ship) { this.scene.remove(this.ship.group); this.ship = null; }
    if (this.clouds) { this.scene.remove(this.clouds); this.clouds = null; }
    if (this.rain) { this.scene.remove(this.rain); this.rain = null; }
    if (this.sky) { this.scene.remove(this.sky); this.sky.geometry.dispose(); this.sky = null; }
    this.world = null;
  }

  // ----------------------------------------------------------
  // 天空 / 日月 / 云 / 雨
  // ----------------------------------------------------------
  _buildSky() {
    // 渐变天空穹顶（大球，内表面，颜色由昼夜着色器控制）
    const geo = new THREE.SphereGeometry(900, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x3a86d4) },
        uBottom: { value: new THREE.Color(0xcfe8f5) },
        uNight: { value: 0 },
      },
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec3 vPos;
        uniform vec3 uTop; uniform vec3 uBottom; uniform float uNight;
        void main(){
          float h = normalize(vPos).y * 0.5 + 0.5;
          vec3 day = mix(uBottom, uTop, smoothstep(0.0, 0.85, h));
          vec3 night = mix(vec3(0.03,0.06,0.14), vec3(0.02,0.03,0.08), h);
          gl_FragColor = vec4(mix(day, night, uNight), 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // 太阳 & 月亮的可视圆盘（用发光面片）
    if (!this.sunDisc) {
      this.sunDisc = new THREE.Mesh(
        new THREE.CircleGeometry(26, 20),
        new THREE.MeshBasicMaterial({ color: 0xffe9a8, fog: false, depthWrite: false })
      );
      this.moonDisc = new THREE.Mesh(
        new THREE.CircleGeometry(18, 20),
        new THREE.MeshBasicMaterial({ color: 0xdfe8ff, fog: false, depthWrite: false })
      );
      this.scene.add(this.sunDisc, this.moonDisc);
    }
  }

  _buildClouds() {
    const cloudTex = makeCloudTexture();
    const count = this.quality.vegetation > 0.7 ? 26 : 16;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: cloudTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
      fog: false,
    });
    this.clouds = new THREE.InstancedMesh(geo, mat, count);
    this.clouds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.clouds.frustumCulled = false;
    this.cloudData = [];
    for (let i = 0; i < count; i++) {
      this.cloudData.push({
        x: (Math.random() - 0.5) * 900,
        y: 150 + Math.random() * 90,
        z: (Math.random() - 0.5) * 900,
        s: 70 + Math.random() * 90,
        speed: 3 + Math.random() * 5,
      });
    }
    this.scene.add(this.clouds);
    this._cloudM = new THREE.Matrix4();
    this._cloudQ = new THREE.Quaternion();
    this._cloudS = new THREE.Vector3();
    this._cloudP = new THREE.Vector3();
  }

  _buildRain() {
    // 雨点：跟随玩家的线条粒子（Points）
    const count = 1400;
    const positions = new Float32Array(count * 3);
    this.rainData = [];
    for (let i = 0; i < count; i++) {
      this.rainData.push({
        x: (Math.random() - 0.5) * 220,
        y: Math.random() * 90,
        z: (Math.random() - 0.5) * 220,
      });
      positions[i * 3] = this.rainData[i].x;
      positions[i * 3 + 1] = this.rainData[i].y;
      positions[i * 3 + 2] = this.rainData[i].z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xbcccd8,
      size: 0.7,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.rain = new THREE.Points(geo, mat);
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  // ----------------------------------------------------------
  // 全局输入
  // ----------------------------------------------------------
  _bindGlobalInput() {
    const el = this.renderer.domElement;

    window.addEventListener("keydown", (e) => this._onKey(e, true));
    window.addEventListener("keyup", (e) => this._onKey(e, false));

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === el;
    });

    el.addEventListener("mousedown", (e) => {
      if (this.paused || !this.ship || this.ship.sunk) return;
      if (!this.pointerLocked) {
        el.requestPointerLock();
        return;
      }
      this.mouseDown[e.button] = true;
      if (e.button === 0) this._playerFire(-1);
      if (e.button === 2) this._playerFire(1);
    });
    window.addEventListener("mouseup", (e) => {
      this.mouseDown[e.button] = false;
    });

    document.addEventListener("mousemove", (e) => {
      if (this.pointerLocked && this.cameraRig) {
        this.cameraRig.onMouseMove(e.movementX || 0, e.movementY || 0);
      }
    });

    el.addEventListener("wheel", (e) => {
      if (this.cameraRig && !this.cameraRig.firstPerson) this.cameraRig.onWheel(e.deltaY);
    }, { passive: true });
  }

  _onKey(e, down) {
    const code = e.code;
    this.keys[code] = down;
    if (!down) return;

    // 这些键仅游戏中有效
    if (this.running && !this.paused && this.ship) {
      if (code === "Space") {
        e.preventDefault();
        const a = this.ship.toggleAnchor();
        this.ui.toast(a ? "已抛锚——船体在风浪中减速稳定" : "起锚——恢复操控");
      }
      if (code === "KeyV") {
        const fp = this.cameraRig.toggleFirstPerson();
        this.ui.toast(fp ? "切换到船长第一人称视角" : "切换到第三人称视角");
      }
      if (code === "KeyZ") this.cameraRig.setSpyglass(true);
      if (code === "F3") this.ui.toggleDebug();
      if (code === "KeyT") {
        this.weatherIndex = (this.weatherIndex + 1) % WEATHERS.length;
        this._applyWeather();
        this.ui.toast("天气切换：" + WEATHERS[this.weatherIndex].name);
      }
    }
    if (code === "Escape" && this.running) {
      // 浏览器在 pointer lock 下按 ESC 会先退出锁定；这里同时负责打开暂停
      if (!this.paused) this.openPause();
    }
  }

  // Z 松开：收起望远镜
  _bindKeyUpSpy() {
    window.addEventListener("keyup", (e) => {
      if (e.code === "KeyZ" && this.cameraRig) this.cameraRig.setSpyglass(false);
    });
  }

  _playerFire(side) {
    if (!this.ship.canFire(side)) {
      this.ui.hintLine(side < 0 ? "左舷炮仍在装填！" : "右舷炮仍在装填！");
      return;
    }
    const pos = [];
    const dir = [];
    this.ship.getMuzzles(side, pos, dir);
    this.combat.fireBroadside(this.ship, side, true, pos, dir);
    this.cameraRig.addShake(0.25);
  }

  // ----------------------------------------------------------
  // 菜单
  // ----------------------------------------------------------
  _bindMenus() {
    const startContinue = document.getElementById("btn-continue");
    if (hasSave()) {
      const data = loadGame();
      this.ui.setSaveInfo(describeSave(data));
      startContinue.disabled = false;
    } else {
      startContinue.disabled = true;
      startContinue.style.opacity = "0.45";
      startContinue.style.cursor = "not-allowed";
    }

    document.getElementById("btn-new").addEventListener("click", () => {
      const seed = this.newSeedString();
      this.settings = Object.assign({}, DEFAULT_SETTINGS);
      this.startGame(seed, null);
    });
    startContinue.addEventListener("click", () => {
      const data = loadGame();
      if (!data) return;
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
      this.startGame(data.seed, data);
    });

    document.getElementById("btn-resume").addEventListener("click", () => this.closePause());
    document.getElementById("btn-save").addEventListener("click", () => {
      this.writeSave();
      this.ui.toast("世界已保存");
    });
    document.getElementById("btn-reset-keep").addEventListener("click", () => {
      const seed = this.seedString;
      clearSave();
      this.startGame(seed, null);
      this.ui.toast("已重置世界（保留种子）");
    });
    document.getElementById("btn-reset-new").addEventListener("click", () => {
      clearSave();
      const seed = this.newSeedString();
      this.startGame(seed, null);
      this.ui.toast("已以新种子重新生成世界");
    });

    // 设置变更即时生效
    this.ui.setView.addEventListener("change", () => this._applySettings());
    this.ui.setSens.addEventListener("input", () => this._applySettings());
    this.ui.setQuality.addEventListener("change", () => this._applySettings());

    this._bindKeyUpSpy();

    // 页面卸载前自动保存
    window.addEventListener("beforeunload", () => {
      if (this.running && this.ship) this.writeSave(true);
    });
  }

  _applySettings() {
    const next = this.ui.readSettingsForm(this.settings);
    this.settings = next;
    if (this.cameraRig) this.cameraRig.setSensitivity(next.sensitivity);
    if (this.chunks) this.chunks.setViewRadius(next.viewDistance);
    const q = QUALITY_PRESETS[next.quality] || QUALITY_PRESETS.medium;
    if (this.quality && this.quality.vegetation !== q.vegetation && this.chunks) {
      this.chunks.setVegetation(q.vegetation);
    }
    this.quality = q;
    if (this.ocean) this.ocean.setQuality(q.waveScale);
    this.renderer.shadowMap.enabled = q.shadows;
    if (this.env) this.env.waveScale = q.waveScale;
  }

  openPause() {
    this.paused = true;
    this.ui.showPause(true);
    this.ui.writeSettingsForm(this.settings);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  closePause() {
    this.paused = false;
    this.ui.showPause(false);
    this.clock.getDelta(); // 丢弃暂停期间的时间
    const el = this.renderer.domElement;
    if (el.requestPointerLock) {
      const p = el.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    }
  }

  /** 进入游戏（saved 为存档数据，null 表示新游戏） */
  startGame(seedString, saved) {
    this.seedString = seedString;
    const restored = saved
      ? {
          ship: saved.ship,
          enemyData: saved.enemies,
          discoveredData: { discovered: saved.discoveredEnemies },
          mappedIslands: saved.mappedIslands,
          dayTime: saved.dayTime,
          weatherIndex: saved.weatherIndex,
        }
      : null;

    this.buildWorld(seedString, this.settings, restored);
    this.ui.showStart(false);
    this.ui.showPause(false);
    this.ui.showHUD(true);

    this.paused = false;
    this.running = true;
    this.accumulator = 0;
    this.clock.start();
    this._prevHp = this.ship.hp;

    this._applyWeather(true);
    this.ui.toast(saved ? "已恢复上次航程" : "新航程开始——顺风满帆，注意浅滩！", 3);
  }

  // ----------------------------------------------------------
  // 天气 / 昼夜
  // ----------------------------------------------------------
  _applyWeather(immediate = false) {
    const w = WEATHERS[this.weatherIndex];
    this.weather = w;
    if (this.ocean) {
      this.ocean.setWeather({
        windWave: w.wave,
        shallowColor: w.shallowColor,
        deepColor: w.deepColor,
      });
    }
    this.fog.color.setHex(w.fogColor);
    this.fog.near = w.fogNear;
    this.fog.far = w.fogFar;
    this.hemi.color.setHex(w.hemiSky);
    this.hemi.groundColor.setHex(w.hemiGround);
    if (this.ocean) this.ocean.setFog(this.fog.color, this.fog.near, this.fog.far);
    if (this.rain) this.rain.material.opacity = w.rain * 0.65;
  }

  _updateWeather(dt) {
    // 天气持续一段时间后自动轮换
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      this.weatherIndex = (this.weatherIndex + 1) % WEATHERS.length;
      this.weatherTimer = 35 + Math.random() * 30;
      this._applyWeather();
      this.ui.toast("天气变化：" + WEATHERS[this.weatherIndex].name);
    }
    // 风向缓慢变化（暴风雨中变化更快）
    this.windAngle += dt * (0.02 + this.weather.wind * 0.02) * (Math.sin(this.dayTime * 40) * 0.5 + 0.5);
  }

  /** 构造当前环境对象（风 / 浪），传给船与 AI */
  _makeEnv() {
    const w = this.weather;
    return {
      windDir: new THREE.Vector2(Math.sin(this.windAngle), Math.cos(this.windAngle)),
      windStrength: w.wind,
      waveTime: this.ocean.time,
      waveWind: w.wave,
      waveScale: (this.quality ? this.quality.waveScale : 1),
    };
  }

  /** 昼夜循环：太阳 / 月亮轨迹、天空、雾色、方向光 */
  _updateDayNight(dt) {
    this.dayTime = (this.dayTime + dt / this.dayLength) % 1;
    const t = this.dayTime;

    // 太阳角度：t=0.25 日出（东方），t=0.75 日落
    const sunAngle = (t - 0.25) * Math.PI * 2;
    const sunY = Math.sin(sunAngle);
    const sunX = Math.cos(sunAngle);
    const sunDir = new THREE.Vector3(sunX, sunY, 0.35).normalize();

    // 白天系数（太阳高度决定）
    const day = THREE.MathUtils.clamp(sunY * 1.6 + 0.25, 0, 1);
    const dawnDusk = Math.max(0, 1 - Math.abs(sunY) * 4); // 日出日落暖色

    // 方向光
    this.sun.position.copy(sunDir).multiplyScalar(150).add(this.ship.position);
    this.sun.target.position.copy(this.ship.position);
    this.sun.intensity = damp(this.sun.intensity, 0.15 + day * 1.35, 3, dt);
    const sunCol = new THREE.Color(0xfff2d0).lerp(new THREE.Color(0xff9b4e), dawnDusk * 0.7);
    this.sun.color.lerp(sunCol, 1 - Math.exp(-3 * dt));

    // 月光
    const moonDir = sunDir.clone().multiplyScalar(-1);
    this.moon.position.copy(moonDir).multiplyScalar(150).add(this.ship.position);
    this.moon.target.position.copy(this.ship.position);
    this.moon.intensity = damp(this.moon.intensity, (1 - day) * 0.32, 3, dt);

    // 半球 / 环境强度
    this.hemi.intensity = damp(this.hemi.intensity, 0.35 + day * 0.65, 3, dt);
    this.ambient.intensity = damp(this.ambient.intensity, 0.08 + day * 0.14, 3, dt);

    // 天空颜色：夜晚深蓝 → 日出橙 → 白天蓝
    const dayTop = new THREE.Color(0x3a86d4);
    const dayBottom = new THREE.Color(0xcfe8f5);
    const nightTop = new THREE.Color(0x07101f);
    const nightBottom = new THREE.Color(0x101c2e);
    const duskTop = new THREE.Color(0x3a4a86);
    const duskBottom = new THREE.Color(0xf2a15b);

    const top = nightTop.clone().lerp(dayTop, day).lerp(duskTop, dawnDusk * 0.5);
    const bottom = nightBottom.clone().lerp(dayBottom, day).lerp(duskBottom, dawnDusk * 0.6);
    this.sky.material.uniforms.uTop.value.lerp(top, 1 - Math.exp(-3 * dt));
    this.sky.material.uniforms.uBottom.value.lerp(bottom, 1 - Math.exp(-3 * dt));
    this.sky.material.uniforms.uNight.value = damp(this.sky.material.uniforms.uNight.value, 1 - day, 3, dt);
    this.sky.position.copy(this.ship.position);

    // 雾色随昼夜与天气调和
    const weatherFog = new THREE.Color(this.weather.fogColor);
    const nightFog = new THREE.Color(0x0a1320);
    this.fog.color.lerp(weatherFog.clone().lerp(nightFog, (1 - day) * 0.7), 1 - Math.exp(-2 * dt));

    // 太阳 / 月亮圆盘位置（挂在天空穹顶内侧）
    this.sunDisc.position.copy(sunDir).multiplyScalar(820).add(this.ship.position);
    this.sunDisc.quaternion.copy(this.camera.quaternion);
    this.sunDisc.visible = sunY > -0.12;
    this.moonDisc.position.copy(moonDir).multiplyScalar(820).add(this.ship.position);
    this.moonDisc.quaternion.copy(this.camera.quaternion);
    this.moonDisc.visible = sunY < 0.12;

    if (this.ocean) {
      this.ocean.setSun(sunDir, this.sky.material.uniforms.uBottom.value);
      this.ocean.setFog(this.fog.color, this.fog.near, this.fog.far);
    }

    // 植被风摆随天气风力
    windUniforms.uWindStrength.value = this.weather.wind;
  }

  _updateClouds(dt) {
    if (!this.clouds) return;
    const w = this.weather;
    this.clouds.material.opacity = 0.35 + w.cloud * 0.55;
    for (let i = 0; i < this.cloudData.length; i++) {
      const c = this.cloudData[i];
      c.x += c.speed * w.wind * dt * 0.6;
      // 围绕玩家循环
      const rx = c.x - this.ship.position.x;
      const rz = c.z - this.ship.position.z;
      if (Math.abs(rx) > 500) c.x = this.ship.position.x - Math.sign(rx) * 500;
      if (Math.abs(rz) > 500) c.z = this.ship.position.z - Math.sign(rz) * 500;
      this._cloudP.set(c.x, c.y, c.z);
      this._cloudQ.identity();
      this._cloudS.set(c.s, c.s * 0.45, 1);
      this._cloudM.compose(this._cloudP, this._cloudQ, this._cloudS);
      this.clouds.setMatrixAt(i, this._cloudM);
    }
    this.clouds.instanceMatrix.needsUpdate = true;
  }

  _updateRain(dt) {
    if (!this.rain) return;
    const pos = this.rain.geometry.attributes.position;
    const strength = this.weather.rain;
    const fall = 55;
    for (let i = 0; i < this.rainData.length; i++) {
      const r = this.rainData[i];
      r.y -= fall * dt * (0.7 + strength * 0.6);
      r.x += 4 * dt * strength; // 风把雨吹斜
      if (r.y < 0) {
        r.x = (Math.random() - 0.5) * 220;
        r.y = 70 + Math.random() * 30;
        r.z = (Math.random() - 0.5) * 220;
      }
      pos.setXYZ(i, this.ship.position.x + r.x, r.y, this.ship.position.z + r.z);
    }
    pos.needsUpdate = true;
  }

  // ----------------------------------------------------------
  // 固定步长模拟
  // ----------------------------------------------------------
  simulate(dt) {
    const env = this._makeEnv();
    this.env = env;

    this._updateWeather(dt);

    // 玩家输入 → 舵 / 帆
    const k = this.keys;
    let rudder = 0;
    if (k["KeyA"]) rudder -= 1;
    if (k["KeyD"]) rudder += 1;
    this.ship.setRudder(rudder);
    if (k["KeyW"]) this.ship.adjustSailOpen(dt, 1);
    if (k["KeyS"]) this.ship.adjustSailOpen(dt, -1);
    if (k["KeyQ"]) this.ship.adjustTrim(dt, 1);
    if (k["KeyE"]) this.ship.adjustTrim(dt, -1);
    if (k["KeyZ"]) this.cameraRig.setSpyglass(true);

    // 玩家物理
    this.ship.step(dt, env);

    // AI（战斗开火通过回调进入 combat）
    this.enemies.update(dt, this.ship, env, (enemy, side) => this._enemyFire(enemy, side));

    // 炮弹 / 粒子
    this.combat.update(dt, this.ship, this.enemies, env, this.cameraRig);

    // 受损冒烟
    if (this.ship.hp < this.ship.maxHp * 0.75 && !this.ship.sunk) {
      this.combat.emitDamageSmoke(this.ship, 1 - this.ship.hp / this.ship.maxHp);
    }
    for (const e of this.enemies.enemies) {
      if (e.ship.hp < e.ship.maxHp * 0.6 && !e.ship.sunk) {
        this.combat.emitDamageSmoke(e.ship, 1 - e.ship.hp / e.ship.maxHp);
      }
    }

    this._handleCombatEvents();
    this._updateDiscovery();
    this._updateMapping();
  }

  _enemyFire(enemy, side) {
    const pos = [];
    const dir = [];
    enemy.ship.getMuzzles(side, pos, dir);
    // AI 炮口略微朝玩家修正，保证有威胁但不百发百中
    for (let i = 0; i < dir.length; i++) {
      const to = this.ship.position.clone().sub(pos[i]);
      to.y += 1.2;
      to.normalize();
      const aimError = 0.08;
      dir[i].lerp(to, 0.72).add(new THREE.Vector3(
        (Math.random() - 0.5) * aimError,
        (Math.random() - 0.5) * aimError,
        (Math.random() - 0.5) * aimError
      )).normalize();
    }
    this.combat.fireBroadside(enemy.ship, side, false, pos, dir);
  }

  /** 战斗事件 → HUD 提示、击沉结算、玩家重生 */
  _handleCombatEvents() {
    const ev = this.combat.events;
    if (ev.enemyHit > 0) this.ui.hintLine("命中敌船！");
    if (ev.playerHit > 0) this.ui.hintLine("我船中弹！");
    if (ev.enemySunk > 0) {
      this.ui.toast("击沉一艘海盗船！", 2.6);
      if (this.enemies.sunkCount >= this.enemies.totalCount) {
        this.ui.toast("★ 所有海盗船均已被肃清，海域恢复平静 ★", 5);
      }
    }
    if (ev.playerSunk) {
      this.ui.toast("船体沉没……在安全海域重生", 3);
      // 优先在沉没点附近找深水；findSafePosition 会螺旋向外扩大搜索
      const safe = this.world.findSafePosition(this.ship.position.x, this.ship.position.z, 11, 16);
      this.ship.respawnAt(safe.x, safe.z, safe.heading);
    }
    // 触礁提示（仅当本帧伤害来自搁浅 / 暗礁）
    if (this.ship.hp < this._prevHp - 0.05 && ev.playerHit === 0 && this.ship.lastDamageCause === "ground") {
      if (this._groundWarn <= 0) {
        this.ui.hintLine("触礁 / 搁浅！船体受损，快离开浅滩");
        this._groundWarn = 1.2;
      }
    }
    this._groundWarn -= 1 / 60;
    this._prevHp = this.ship.hp;
  }

  /** 发现机制：按距离 / 望远镜刷新；交火时敌船也会暴露 */
  _updateDiscovery() {
    const spy = this.cameraRig.spyglass ? 2.2 : 1;
    this.enemies.refreshDiscovery(this.ship, this.camera, spy);
  }

  /** 测绘：玩家靠近岛屿（或用望远镜看清）时把岛记入小地图 */
  _updateMapping() {
    for (let i = 0; i < this.world.islands.length; i++) {
      if (this.mappedIslands.has(i)) continue;
      const isl = this.world.islands[i];
      const d = Math.hypot(this.ship.position.x - isl.cx, this.ship.position.z - isl.cz);
      const range = this.cameraRig.spyglass ? 300 : Math.max(isl.rx, isl.rz) + 60;
      if (d < range) {
        this.mappedIslands.add(i);
        this.ui.toast("已测绘一座岛屿（小地图金色轮廓）", 1.8);
      }
    }
  }

  // ----------------------------------------------------------
  // 存档
  // ----------------------------------------------------------
  writeSave(silent = false) {
    if (!this.ship || !this.enemies) return;
    const enemySave = this.enemies.serialize();
    const data = {
      seed: this.seedString,
      ship: this.ship.serialize(),
      enemies: enemySave.enemies,
      sunkEnemies: this.enemies.enemies.filter((e) => e.ship.sunk).map((e) => e.key),
      discoveredEnemies: [...this.enemies.discovered],
      mappedIslands: [...this.mappedIslands],
      weatherIndex: this.weatherIndex,
      dayTime: this.dayTime,
      windAngle: this.windAngle,
      settings: this.settings,
    };
    saveGame(data);
    if (!silent) this.ui.setSaveInfo(describeSave(data));
  }

  // ----------------------------------------------------------
  // 每帧
  // ----------------------------------------------------------
  frame() {
    requestAnimationFrame(() => this.frame());
    const frameDt = Math.min(0.1, this.clock.getDelta());
    this.fpsSmooth = damp(this.fpsSmooth, 1 / Math.max(frameDt, 1e-4), 2, frameDt);

    if (this.running && !this.paused) {
      // 固定步长物理子步
      this.accumulator += frameDt;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
        this.simulate(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === MAX_SUBSTEPS) this.accumulator = 0;

      // 视效更新（可变帧率）
      this._visualUpdate(frameDt);

      // 每 20 秒静默自动保存
      this.autosaveTimer += frameDt;
      if (this.autosaveTimer > 20) {
        this.autosaveTimer = 0;
        this.writeSave(true);
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.ui.tickTimers(frameDt);
  }

  _visualUpdate(dt) {
    // 地形区块（船移动不重建网格，只增删区块）
    this.chunks.update(this.ship.position.x, this.ship.position.z, 2);

    // 海面 / 天空 / 天气视觉
    this.ocean.update(dt, this.ship.position.x, this.ship.position.z);
    this._updateDayNight(dt);
    this._updateClouds(dt);
    this._updateRain(dt);
    windUniforms.uTime.value += dt;

    // 相机
    this.cameraRig.update(
      this.ship,
      dt,
      this.ocean.time,
      this.weather.wave,
      this.quality.waveScale,
      waveHeight
    );
    this.ui.showSpyglass(this.cameraRig.spyglass);

    // 小地图
    this.minimap.draw(this.ship, this.enemies, this.mappedIslands, this.windAngle);

    // HUD
    const depth = this.world.depthAt(this.ship.position.x, this.ship.position.z);
    this.ui.updateShipHUD(this.ship, depth);
    this.ui.drawCompass(this.ship.heading, this.windAngle, this.ship.efficiency);

    const windLabel = this.weather.name === "暴风雨" ? "狂风"
      : this.weather.name === "强风" ? "劲风" : "和风";
    this.ui.updateStats({
      fps: Math.round(this.fpsSmooth),
      x: this.ship.position.x,
      y: this.ship.position.y,
      z: this.ship.position.z,
      chunkX: Math.floor(this.ship.position.x / CHUNK_SIZE),
      chunkZ: Math.floor(this.ship.position.z / CHUNK_SIZE),
      weather: this.weather.name,
      timeOfDay: timeLabel(this.dayTime),
      wind: this.weather.wind,
      windLabel,
      heading: this.ship.heading,
      sunk: this.enemies.sunkCount,
      total: this.enemies.totalCount,
      anchored: this.ship.anchored,
      firstPerson: this.cameraRig.firstPerson,
      spyglass: this.cameraRig.spyglass,
    });

    // F3 调试面板
    if (!this.ui.debug.classList.contains("hidden")) {
      const info = this.renderer.info;
      const heap = performance.memory ? performance.memory.usedJSHeapSize : null;
      this.enemies.setDebugPlayer(this.ship);
      this.ui.updateDebug({
        chunks: this.chunks.chunkCount,
        viewRadius: this.settings.viewDistance,
        calls: info.render.calls,
        triangles: info.render.triangles,
        jsHeap: heap,
        weather: this.weather.name,
        timeOfDay: timeLabel(this.dayTime),
        waveScale: this.quality.waveScale * this.weather.wave,
      }, this.enemies.statusLines());
    }
  }
}

// 字符串 → 32 位 hash（种子）
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ----------------------------------------------------------
// 启动
// ----------------------------------------------------------
function boot() {
  if (isMobileDevice()) {
    document.getElementById("mobile-warning").classList.remove("hidden");
    document.getElementById("start-screen").classList.add("hidden");
    return;
  }
  try {
    const game = new Game();
    game.frame();
    window.__game = game; // 便于控制台调试
  } catch (err) {
    console.error("WebGL 初始化失败：", err);
    const warn = document.getElementById("mobile-warning");
    warn.classList.remove("hidden");
    warn.querySelector("h2").textContent = "无法初始化 WebGL";
    warn.querySelector("p").textContent = "请使用支持 WebGL 的桌面浏览器（Chrome / Edge / Firefox）并开启硬件加速。";
    document.getElementById("start-screen").classList.add("hidden");
  }
}

boot();
