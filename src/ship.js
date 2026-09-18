// ============================================================
// ship.js —— 玩家帆船
// 自实现船舶动力学（无物理引擎）：
//   帆面受风（顺风高效、顶风失速）+ 质量 / 惯性 / 水阻 / 舵效，
//   波浪浮力姿态，触礁 / 搁浅 / 炮击耐久损耗，抛锚制动。
// ============================================================
import * as THREE from "three";
import { waveHeight } from "./ocean.js";
import { WATER_LEVEL, WORLD_HALF } from "./world.js";
import {
  makeSailTexture,
  makeWoodTexture,
  makeFlagTexture,
  makePirateFlagTexture,
  makeCompassDialTexture,
} from "./textures.js";

export const PLAYER_MAX_HP = 100;

// 船物理参数
const SHIP_MASS = 12;                 // 质量（相对单位）
const SAIL_FORCE = 15.5;              // 满帆满效率推力
const WATER_DRAG = 0.9;               // 水阻
const LATERAL_DRAG = 4.2;             // 横向水阻（船沿船长方向走得更顺）
const MAX_SPEED = 15;                 // m/s 上限（约 29 节）
const RUDDER_RATE = 0.62;             // 满舵转向角速度 rad/s
const KEEL_DEPTH = 1.6;               // 龙骨吃水
const ANCHOR_DECEL = 1.8;             // 锚链阻力

// 左舷 / 右舷炮位（局部坐标；x=横向，z=船首方向）
const GUN_PORT_X = -1.72;
const GUN_STAR_X = 1.72;
const GUN_Z = [-1.55, -0.52, 0.52, 1.55];

const GRAVITY = 9.81;

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _wave = { y: 0, nx: 0, ny: 1, nz: 0, dx: 0, dz: 0 };

/** 风帆效率：相对风向角 alpha（弧度，0=迎风顶风, PI=顺风），返回 0~1 */
export function sailEfficiency(alpha) {
  const a = Math.abs(alpha);
  const PI = Math.PI;
  if (a < PI / 6) {
    // 正顶风 30° 死区：几乎失速（无法航行）
    return 0.03;
  }
  if (a < PI / 2) {
    // 30°~90° 侧风：效率快速上升
    const t = (a - PI / 6) / (PI / 2 - PI / 6);
    return 0.05 + 0.72 * (t * t * (3 - 2 * t));
  }
  if (a < PI * 5 / 6) {
    // 90°~150° 侧顺风：最佳航行区间
    const t = (a - PI / 2) / (PI / 3);
    return 0.77 + 0.23 * Math.sin(t * PI / 2);
  }
  // 正顺风略低于侧顺风（帆船的真实特性）
  const t = (a - PI * 5 / 6) / (PI / 6);
  return 1.0 - 0.08 * t;
}

/** 帆向微调收益：帆面与来风越垂直，效率越高 */
function trimBonus(trim) {
  // trim ∈ [-1, 1]，0 为自动中性；玩家调好可小幅增益
  return 1 - Math.min(0.32, Math.abs(trim) * 0.32);
}

// ============================================================
// Ship
// ============================================================
export class Ship {
  /**
   * @param {World} world
   * @param {object} textures 共享纹理 { sail, wood, flag, compass }
   * @param {object} opts { pirate?:boolean }
   */
  constructor(world, textures, opts = {}) {
    this.world = world;
    this.textures = textures;
    this.isPlayer = !opts.pirate;

    // --- 运动状态 ---
    this.position = new THREE.Vector3();
    this.heading = 0;          // 船头朝向（yaw），+Z 为 0
    this.velocity = new THREE.Vector3();
    this.sailOpen = 0.35;      // 帆展开程度 0~1
    this.rudder = 0;          // 舵量 -1(左) ~ 1(右)
    this.sailTrim = 0;        // 帆向微调 -1~1
    this.anchored = false;
    this.groundFactor = 1;    // 1=深水中，<1=浅滩 / 搁浅减速

    // --- 耐久 / 火力 ---
    this.maxHp = this.isPlayer ? PLAYER_MAX_HP : 56;
    this.hp = this.maxHp;
    this.gunCooldownPort = 0;
    this.gunCooldownStar = 0;
    this.gunReload = this.isPlayer ? 7 : 9.5;
    this.gunRange = this.isPlayer ? 150 : 120;
    this.sunk = false;
    this.sinkTimer = 0;
    this.lastDamageCause = "";

    // 帆效率（供 HUD / AI 使用）
    this.efficiency = 0;
    this.apparentWindAngle = 0;

    // 外部环境（main 每帧更新）
    this.windDir = new THREE.Vector2(1, 0); // 风“吹向”的水平方向
    this.windStrength = 1;                   // 0.55~2
    this.waveTime = 0;
    this.waveWind = 1;
    this.waveScale = 1;

    this.group = this._buildModel(opts.pirate ? 0x5a2222 : 0x33506b, !!opts.pirate);
    // 整条船的阴影统一在这里开关（含帆 / 桅杆）
    this.group.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
      }
    });
  }

  // ----------------------------------------------------------
  // 模型构建
  // ----------------------------------------------------------
  _buildModel(hullTint, pirate) {
    const group = new THREE.Group();

    // 船体：用自定义顶点挤出船形（低多边形）
    const hullGeo = buildHullGeometry();
    const woodTex = this.textures.wood;
    this.hullMaterial = new THREE.MeshStandardMaterial({
      color: hullTint,
      map: woodTex,
      roughness: 0.9,
      metalness: 0,
      flatShading: true,
    });
    const hull = new THREE.Mesh(hullGeo, this.hullMaterial);
    hull.castShadow = true;
    hull.receiveShadow = true;
    group.add(hull);

    // 甲板
    const deckGeo = new THREE.BoxGeometry(2.6, 0.18, 6.0);
    const deckMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.95, flatShading: true });
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.y = 0.78;
    deck.castShadow = true;
    group.add(deck);

    // 尾楼
    const stern = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.8, 1.1), deckMat);
    stern.position.set(0, 1.2, -2.35);
    stern.castShadow = true;
    group.add(stern);

    // 桅杆与帆（帆单独引用，用来随帆位缩放）
    this.sails = [];
    this.masts = [];
    const sailMat = new THREE.MeshStandardMaterial({
      map: this.textures.sail,
      side: THREE.DoubleSide,
      roughness: 1,
      transparent: true,
      opacity: 0.96,
      flatShading: true,
    });
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x6b4726, roughness: 1, flatShading: true });
    const mastZs = [1.4, -0.6];
    for (let i = 0; i < mastZs.length; i++) {
      const mastH = 6.4;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, mastH, 6), mastMat);
      mast.position.set(0, 0.85 + mastH / 2, mastZs[i]);
      mast.castShadow = true;
      group.add(mast);
      this.masts.push(mast);

      // 横向帆桁
      const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.6, 5), mastMat);
      yard.rotation.z = Math.PI / 2;
      yard.position.set(0, mastH - 0.2, mastZs[i]);
      group.add(yard);

      // 方形横帆（默认朝向：法向沿船首尾 z 轴，受风来自侧面）
      const sailGeo = new THREE.PlaneGeometry(3.3, 3.0, 1, 1);
      const sail = new THREE.Mesh(sailGeo, sailMat);
      sail.rotation.y = Math.PI / 2;
      sail.position.set(0, mastH - 1.9, mastZs[i]);
      sail.castShadow = true;
      group.add(sail);
      this.sails.push(sail);
    }

    // 旗帜
    const flagGeo = new THREE.PlaneGeometry(1.0, 0.6);
    const flagMat = new THREE.MeshStandardMaterial({
      map: pirate ? this.textures.pirateFlag : this.textures.flag,
      side: THREE.DoubleSide,
      transparent: true,
      roughness: 1,
    });
    this.flag = new THREE.Mesh(flagGeo, flagMat);
    this.flag.position.set(0.55, 7.4, -0.6);
    group.add(this.flag);

    // 两舷火炮（简单黑色圆筒）
    this.gunPortPoints = [];
    this.gunStarPoints = [];
    const gunGeo = new THREE.CylinderGeometry(0.13, 0.15, 1.0, 6);
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.6, metalness: 0.3, flatShading: true });
    for (const z of GUN_Z) {
      for (const side of [-1, 1]) {
        const gun = new THREE.Mesh(gunGeo, gunMat);
        gun.rotation.z = Math.PI / 2; // 圆筒沿 x 轴指向两舷
        gun.position.set(side * 1.55, 0.85, z);
        group.add(gun);
        const muzzle = new THREE.Object3D();
        muzzle.position.set(side * 2.05, 0.9, z);
        group.add(muzzle);
        if (side < 0) this.gunPortPoints.push(muzzle);
        else this.gunStarPoints.push(muzzle);
      }
    }

    // 驾驶舱罗盘（贴在尾楼栏杆上）
    if (this.isPlayer) {
      const compass = new THREE.Mesh(
        new THREE.CylinderGeometry(0.34, 0.34, 0.06, 12),
        new THREE.MeshStandardMaterial({ map: this.textures.compass, roughness: 0.8 })
      );
      compass.position.set(0, 1.12, -1.78);
      group.add(compass);
    }

    return group;
  }

  /** 船长第一人称观察位（船尾舵轮处） */
  getHelmPosition(out) {
    out.set(0, 2.05, -1.7);
    this.group.localToWorld(out);
    return out;
  }

  // ----------------------------------------------------------
  // 状态设置 / 存档
  // ----------------------------------------------------------
  setTransform(x, z, heading) {
    this.position.set(x, 0, z);
    this.heading = heading;
    this.velocity.set(0, 0, 0);
  }

  serialize() {
    return {
      x: this.position.x,
      z: this.position.z,
      heading: this.heading,
      hp: this.hp,
      sailOpen: this.sailOpen,
      sailTrim: this.sailTrim,
      anchored: this.anchored,
    };
  }

  deserialize(d) {
    if (!d) return;
    this.position.set(d.x, 0, d.z);
    this.heading = d.heading;
    this.hp = d.hp;
    this.sailOpen = d.sailOpen;
    this.sailTrim = d.sailTrim || 0;
    this.anchored = !!d.anchored;
    this.velocity.set(0, 0, 0);
  }

  /** 当前航速（节 = m/s * 1.94384） */
  get speedKnots() {
    return this.velocity.length() * 1.94384;
  }

  getForward(out) {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  // ----------------------------------------------------------
  // 输入
  // ----------------------------------------------------------
  setRudder(v) {
    this.rudder = THREE.MathUtils.clamp(v, -1, 1);
  }
  adjustSailOpen(dt, dir) {
    this.sailOpen = THREE.MathUtils.clamp(this.sailOpen + dir * dt * 0.55, 0, 1);
  }
  adjustTrim(dt, dir) {
    this.sailTrim = THREE.MathUtils.clamp(this.sailTrim + dir * dt * 0.8, -1, 1);
  }
  toggleAnchor() {
    this.anchored = !this.anchored;
    return this.anchored;
  }

  /** side: -1 左舷 / 1 右舷 */
  canFire(side) {
    if (this.sunk) return false;
    return side < 0 ? this.gunCooldownPort <= 0 : this.gunCooldownStar <= 0;
  }
  markFired(side) {
    if (side < 0) this.gunCooldownPort = this.gunReload;
    else this.gunCooldownStar = this.gunReload;
  }
  gunProgress(side) {
    const cd = side < 0 ? this.gunCooldownPort : this.gunCooldownStar;
    return THREE.MathUtils.clamp(1 - cd / this.gunReload, 0, 1);
  }

  /** 取该舷炮口世界坐标与射击朝向（略向外、带仰角） */
  getMuzzles(side, outPos, outDir) {
    outPos.length = 0;
    outDir.length = 0;
    const pts = side < 0 ? this.gunPortPoints : this.gunStarPoints;
    for (const pt of pts) {
      const wp = new THREE.Vector3();
      pt.getWorldPosition(wp);
      outPos.push(wp);
      this.getForward(_fwd);
      _right.set(_fwd.z, 0, -_fwd.x).multiplyScalar(side);
      _tmp.copy(_right).addScaledVector(_fwd, 0.08);
      _tmp.y = 0.07;
      _tmp.normalize();
      outDir.push(_tmp.clone());
    }
  }

  // ----------------------------------------------------------
  // 固定步长物理（自实现，无物理引擎）
  // ----------------------------------------------------------
  step(dt, env) {
    if (this.sunk) {
      // 沉没：船体在约 6 秒内沉入水下后隐藏
      this.sinkTimer += dt;
      const s = Math.min(1, this.sinkTimer / 6);
      this.group.visible = s < 1;
      this._applyBuoyancy(dt, env);
      this.group.position.y -= dt * 1.4;
      this.group.rotation.z += dt * 0.08;
      return;
    }

    this.windDir.set(env.windDir.x, env.windDir.y);
    this.windStrength = env.windStrength;
    this.waveTime = env.waveTime;
    this.waveWind = env.waveWind;
    this.waveScale = env.waveScale;

    if (this.gunCooldownPort > 0) this.gunCooldownPort = Math.max(0, this.gunCooldownPort - dt);
    if (this.gunCooldownStar > 0) this.gunCooldownStar = Math.max(0, this.gunCooldownStar - dt);

    this.getForward(_fwd);
    _right.set(_fwd.z, 0, -_fwd.x);

    // ---- 风与船头夹角（windDir = 风吹向的方向） ----
    const wind = _tmp.set(env.windDir.x, 0, env.windDir.y).normalize();
    // 直接用“船头方向 → 风吹向”的有向夹角：
    // alpha=0 船头正对风吹去（顶风失速），alpha=±PI 顺风
    let alpha = Math.atan2(wind.x * _fwd.z - wind.z * _fwd.x, wind.x * _fwd.x + wind.z * _fwd.z);
    if (alpha > Math.PI) alpha -= Math.PI * 2;
    if (alpha < -Math.PI) alpha += Math.PI * 2;
    this.apparentWindAngle = alpha;

    // ---- 帆效率 = 受风角效率 × 帆位 × 微调 ----
    const angleEff = sailEfficiency(alpha);
    this.efficiency = angleEff * this.sailOpen * trimBonus(this.sailTrim);

    // ---- 推力（顶风接近零，顺风满帆） ----
    const thrustMag = (SAIL_FORCE * this.efficiency * env.windStrength * 0.55) / SHIP_MASS;
    this.velocity.addScaledVector(_fwd, thrustMag * dt);

    // ---- 纵向水阻 + 横向龙骨抗漂 ----
    const fwdSpeed = this.velocity.dot(_fwd);
    const sideSpeed = this.velocity.dot(_right);
    const dragF = WATER_DRAG * 0.16 + 0.016 * fwdSpeed * fwdSpeed;
    let vf = fwdSpeed - fwdSpeed * dragF * dt;
    let vs = sideSpeed - sideSpeed * LATERAL_DRAG * dt;

    // ---- 浅滩 / 搁浅 / 触礁 ----
    const groundH = this.world.heightAt(this.position.x, this.position.z);
    const surf =
      waveHeight(this.position.x, this.position.z, env.waveTime, env.waveWind, env.waveScale) -
      WATER_LEVEL;
    const clearance = surf - groundH;
    if (clearance < KEEL_DEPTH) {
      const touch = THREE.MathUtils.clamp((KEEL_DEPTH - clearance) / KEEL_DEPTH, 0, 1);
      this.groundFactor = 1 - touch;
      // 搁浅：强摩擦（按指数衰减，避免量纲错误导致完全不减速）
      vf *= Math.exp(-touch * 3.2 * dt);
      vs *= Math.exp(-touch * 6.0 * dt);
      // 高速冲上陆地 / 暗礁：冲击伤害（每次接触冲击衰减，避免子步内连扣）
      const speedBefore = Math.hypot(this.velocity.x, this.velocity.z);
      if (groundH > 0.4 + surf && speedBefore > 3.0) {
        vf *= 0.82;
        vs *= 0.82;
        this.damage(speedBefore * 0.9 * dt + speedBefore * 0.12, "ground");
      }
    } else {
      this.groundFactor = 1;
    }

    // ---- 抛锚制动 ----
    if (this.anchored) {
      const anchorF = ANCHOR_DECEL * dt;
      vf -= Math.sign(vf) * Math.min(Math.abs(vf), anchorF);
      vs -= Math.sign(vs) * Math.min(Math.abs(vs), anchorF * 1.5);
    }

    this.velocity.copy(_fwd).multiplyScalar(vf).addScaledVector(_right, vs);
    const maxV = MAX_SPEED * (this.anchored ? 0.15 : 1);
    if (this.velocity.length() > maxV) this.velocity.setLength(maxV);

    // ---- 舵效：有船速才能转；倒车打舵反向 ----
    const steer = THREE.MathUtils.clamp(Math.abs(vf) / 4.5, 0, 1);
    const turnSign = vf >= 0 ? 1 : -1;
    if (!this.anchored) {
      this.heading += this.rudder * RUDDER_RATE * steer * turnSign * dt;
    } else {
      this.heading += 0.02 * Math.sin(env.waveTime * 0.3) * dt;
    }

    // ---- 位置积分 ----
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // 世界边界软墙
    const lim = WORLD_HALF - 8;
    if (this.position.x > lim) { this.position.x = lim; this.velocity.x *= -0.3; }
    if (this.position.x < -lim) { this.position.x = -lim; this.velocity.x *= -0.3; }
    if (this.position.z > lim) { this.position.z = lim; this.velocity.z *= -0.3; }
    if (this.position.z < -lim) { this.position.z = -lim; this.velocity.z *= -0.3; }

    this._applyBuoyancy(dt, env);
    this._updateSailVisuals(env);
  }

  /** 浮力姿态：采样船体前 / 后 / 左 / 右波高，得到纵摇、横摇 */
  _applyBuoyancy(dt, env) {
    this.getForward(_fwd);
    _right.set(_fwd.z, 0, -_fwd.x);

    const sample = (ox, oz) => {
      _tmp.copy(this.position).addScaledVector(_fwd, oz).addScaledVector(_right, ox);
      return waveHeight(_tmp.x, _tmp.z, env.waveTime, env.waveWind, env.waveScale, _wave) - 0.05;
    };

    const yC = sample(0, 0);
    const yF = sample(0, 2.8);
    const yB = sample(0, -2.8);
    const yR = sample(1.4, 0);
    const yL = sample(-1.4, 0);

    const pitchTarget = Math.atan2(yB - yF, 5.6) * 0.9;
    const rollTarget = Math.atan2(yR - yL, 2.8) * 0.9;
    this._pitch = lerpAngle(this._pitch || 0, pitchTarget, 1 - Math.exp(-3.2 * dt));
    this._roll = lerpAngle(this._roll || 0, rollTarget, 1 - Math.exp(-3.2 * dt));

    // 搁浅时把船抬到地表上，避免穿透
    const ground = this.world.heightAt(this.position.x, this.position.z);
    const targetY = ground > yC - 0.6 ? Math.max(yC, ground + 0.35) : yC;
    this.position.y += (targetY - this.position.y) * (1 - Math.exp(-5 * dt));

    this.group.position.copy(this.position);
    this.group.rotation.set(-this._pitch, this.heading, -this._roll, "YXZ");
  }

  /** 帆展开 / 收起；帆桁随风向与微调转动 */
  _updateSailVisuals(env) {
    for (const sail of this.sails) {
      const open = Math.max(0.02, this.sailOpen);
      sail.scale.y += (open - sail.scale.y) * 0.12;
      const desiredYaw = Math.PI / 2 + this.sailTrim * 0.9;
      sail.rotation.y += (desiredYaw - sail.rotation.y) * 0.08;
    }
    if (this.flag) this.flag.rotation.y = Math.sin(env.waveTime * 3.1) * 0.25;
  }

  // ----------------------------------------------------------
  // 伤害 / 沉没 / 重生
  // ----------------------------------------------------------
  damage(amount, cause = "hit") {
    if (this.sunk) return;
    this.hp = Math.max(0, this.hp - amount);
    this.lastDamageCause = cause;
    if (this.hp <= 0) this.sink();
  }
  sink() {
    this.sunk = true;
    this.hp = 0;
    this.sinkTimer = 0;
  }
  respawnAt(x, z, heading) {
    this.sunk = false;
    this.sinkTimer = 0;
    this.group.visible = true;
    this.group.rotation.z = 0;
    this.hp = this.maxHp;
    this.setTransform(x, z, heading);
    this.sailOpen = 0.3;
    this.anchored = false;
    this.gunCooldownPort = 0;
    this.gunCooldownStar = 0;
  }
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ============================================================
// 手工低多边形船体（5 个截面 × 4 角，缝合侧面与甲板底面）
// ============================================================
function buildHullGeometry() {
  const stations = [
    { z: -3.0, w: 1.05, top: 0.8, bot: -0.2 },
    { z: -1.6, w: 1.35, top: 0.9, bot: -0.75 },
    { z: 0.0, w: 1.45, top: 0.95, bot: -1.0 },
    { z: 1.6, w: 1.3, top: 0.85, bot: -0.7 },
    { z: 3.0, w: 0.25, top: 0.5, bot: 0.1 },
  ];
  // 截面四角：左舷上、右舷上、右舷下、左舷下
  const rings = stations.map((s) => [
    [-s.w, s.top, s.z],
    [s.w, s.top, s.z],
    [s.w * 0.55, s.bot, s.z],
    [-s.w * 0.55, s.bot, s.z],
  ]);

  const positions = [];
  const indices = [];
  for (const ring of rings) {
    for (const v of ring) positions.push(v[0], v[1], v[2]);
  }
  // 相邻截面缝合四圈四边形
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < 4; k++) {
      const a = i * 4 + k;
      const b = i * 4 + ((k + 1) % 4);
      const c = (i + 1) * 4 + ((k + 1) % 4);
      const d = (i + 1) * 4 + k;
      indices.push(a, b, d, b, c, d);
    }
  }
  // 船尾封口
  indices.push(0, 1, 2, 0, 2, 3);
  // 船首封口（截面已收成尖点，仍补面保证水密）
  const o = (rings.length - 1) * 4;
  indices.push(o, o + 2, o + 1, o, o + 3, o + 2);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** 创建所有船体共享的像素纹理包 */
export function createShipTextures() {
  return {
    sail: makeSailTexture(),
    wood: makeWoodTexture(),
    flag: makeFlagTexture(),
    pirateFlag: makePirateFlagTexture(),
    compass: makeCompassDialTexture(),
  };
}
