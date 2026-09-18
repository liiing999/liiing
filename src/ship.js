// ship.js —— 帆船：低多边形程序化船模、自实现船舶动力学（无物理引擎）、
// 帆面受风效率、舵效、锚、浮力姿态、两舷火炮、耐久与沉没。

import * as THREE from 'three';
import { getTextures } from './textures.js';
import { WORLD_HALF } from './world.js';

const DEG = Math.PI / 180;

// 每舷火炮的纵向局部位置
const CANNON_Z = [-3.4, -1.1, 1.2, 3.4];
const CANNON_X = 3.0;
export const RELOAD_TIME = 5.0; // 装填秒数
export const FIRE_RANGE = 230;  // 火炮射程上限

/**
 * 帆船（玩家与海盗共用，由 isEnemy 区分外观与参数）。
 */
export class Ship {
  /**
   * @param {THREE.Scene} scene
   * @param {object} options
   * @param {boolean} [options.isEnemy]
   * @param {number} [options.maxHp]
   * @param {number} [options.scale]
   */
  constructor(scene, options = {}) {
    this.scene = scene;
    this.isEnemy = !!options.isEnemy;
    this.maxHp = options.maxHp || (this.isEnemy ? 70 : 100);
    this.modelScale = options.scale || 1;

    // ---- 运动状态 ----
    this.position = new THREE.Vector3(0, 0, 40);
    this.heading = 0;                  // 船头朝向（弧度，0 = +Z）
    this.vel = new THREE.Vector2(0, 0); // 水平速度（x,z 分量，单位/秒）
    this.rudder = 0;                  // 舵量 -1（左）.. 1（右）
    this.sailAmount = this.isEnemy ? 0.9 : 0; // 帆展开比例 0..1
    this.yardAngle = 0;               // 帆桁相对船中线的角度（弧度）
    this.anchored = false;

    // ---- 战斗状态 ----
    this.hp = this.maxHp;
    this.alive = true;
    this.sinking = false;
    this.sinkTimer = 0;
    this.reloadPort = 0;
    this.reloadStar = 0;

    // 每帧更新的受风信息（HUD 与 AI 共用）
    this.sailEfficiency = 0;
    this.windAngleToBoat = 0; // 风去向相对船头的夹角 -π..π
    this.idealYard = 0;
    this.grounded = false;

    // 复用临时对象，避免每帧分配
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._tmpNormal = new THREE.Vector3();
    this._windTo = new THREE.Vector2();

    // 天气系统注入的风
    this.windFrom = 0;
    this.windStrength = 0.6;

    this.group = new THREE.Group();
    this.group.scale.setScalar(this.modelScale);
    this.scene.add(this.group);
    this._buildModel();
  }

  /** 构造程序化低多边形船体、桅杆、帆、舵、旗帜与两舷火炮。 */
  _buildModel() {
    const tex = getTextures();

    // ---- 船体：俯视轮廓挤出成有艏艉的船壳 ----
    const hullShape = new THREE.Shape();
    hullShape.moveTo(-1.5, -4.2);
    hullShape.lineTo(1.5, -4.2);
    hullShape.lineTo(1.7, 2.6);
    hullShape.lineTo(0, 4.6);
    hullShape.lineTo(-1.7, 2.6);
    hullShape.lineTo(-1.5, -4.2);
    const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 1.5, bevelEnabled: false });
    hullGeo.rotateX(-Math.PI / 2);
    hullGeo.translate(0, -0.9, 0);
    const hullMat = new THREE.MeshLambertMaterial({
      map: tex.wood, color: this.isEnemy ? 0x8a5a40 : 0xa06a3c
    });
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.castShadow = true;
    this.group.add(hull);

    // 船舷色带
    const stripeGeo = new THREE.BoxGeometry(3.2, 0.35, 5.6);
    const stripeMat = new THREE.MeshLambertMaterial({ color: this.isEnemy ? 0x7a1f18 : 0x224f78 });
    const stripe = new THREE.Mesh(stripeGeo, stripeMat);
    stripe.position.set(0, -0.15, -0.3);
    this.group.add(stripe);

    // ---- 甲板 ----
    const deckGeo = new THREE.BoxGeometry(2.7, 0.18, 7.2);
    const deckMat = new THREE.MeshLambertMaterial({ map: tex.deck });
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.set(0, 0.66, -0.1);
    this.group.add(deck);

    // ---- 桅杆（主桅 + 前桅），帆挂在可绕 Y 旋转的枢轴组上 ----
    this.sailPivots = [];
    this.sailMeshes = [];
    const mastZ = [-1.2, 1.6];
    const mastHeights = [7.2, 5.6];
    const sailTex = this.isEnemy ? tex.sailPirate : tex.sail;
    for (let i = 0; i < 2; i++) {
      const mastGeo = new THREE.CylinderGeometry(0.14, 0.2, mastHeights[i], 6);
      const mastMat = new THREE.MeshLambertMaterial({ color: 0x5c3d20 });
      const mast = new THREE.Mesh(mastGeo, mastMat);
      mast.position.set(0, 0.7 + mastHeights[i] / 2, mastZ[i]);
      this.group.add(mast);

      const pivot = new THREE.Group();
      pivot.position.set(0, 0.7 + mastHeights[i] * (i === 0 ? 0.62 : 0.6), mastZ[i]);
      const yardGeo = new THREE.CylinderGeometry(0.08, 0.08, 5.0, 5);
      const yardMat = new THREE.MeshLambertMaterial({ color: 0x6b4a28 });
      const yard = new THREE.Mesh(yardGeo, yardMat);
      yard.rotation.z = Math.PI / 2;
      pivot.add(yard);

      const sailGeo = new THREE.PlaneGeometry(4.6, i === 0 ? 3.4 : 2.6);
      const sailMat = new THREE.MeshLambertMaterial({
        map: sailTex, side: THREE.DoubleSide, transparent: true
      });
      const sail = new THREE.Mesh(sailGeo, sailMat);
      sail.position.y = -(i === 0 ? 1.7 : 1.3);
      pivot.add(sail);
      this.group.add(pivot);
      this.sailPivots.push(pivot);
      this.sailMeshes.push(sail);
    }

    // ---- 舵（随舵量转动）----
    const rudderGeo = new THREE.BoxGeometry(0.15, 1.0, 0.7);
    const rudderMat = new THREE.MeshLambertMaterial({ color: 0x4a2f18 });
    this.rudderMesh = new THREE.Mesh(rudderGeo, rudderMat);
    this.rudderMesh.position.set(0, -0.2, -4.3);
    this.group.add(this.rudderMesh);

    // ---- 旗帜 ----
    const flagGeo = new THREE.PlaneGeometry(1.4, 0.8);
    const flagMat = new THREE.MeshLambertMaterial({
      map: this.isEnemy ? tex.flagPirate : tex.flagPlayer,
      side: THREE.DoubleSide, transparent: true
    });
    this.flagMesh = new THREE.Mesh(flagGeo, flagMat);
    this.flagMesh.position.set(0.8, 8.0, -1.2);
    this.group.add(this.flagMesh);

    // ---- 两舷火炮（黑粗圆筒），左右各 4 门 ----
    const cannonGeo = new THREE.CylinderGeometry(0.16, 0.22, 1.1, 7);
    cannonGeo.rotateZ(Math.PI / 2);
    const cannonMat = new THREE.MeshLambertMaterial({ color: 0x24272b });
    this.muzzles = { port: [], star: [] };
    for (const z of CANNON_Z) {
      const port = new THREE.Mesh(cannonGeo, cannonMat);
      port.position.set(-CANNON_X, 0.55, z);
      this.group.add(port);
      this.muzzles.port.push(new THREE.Vector3(-CANNON_X - 0.6, 0.55, z));
      const star = new THREE.Mesh(cannonGeo, cannonMat);
      star.position.set(CANNON_X, 0.55, z);
      this.group.add(star);
      this.muzzles.star.push(new THREE.Vector3(CANNON_X + 0.6, 0.55, z));
    }
  }

  /**
   * 设置当前风。
   * @param {number} fromAngle 风的来向角（弧度）
   * @param {number} strength 0..1
   */
  setWind(fromAngle, strength) {
    this.windFrom = fromAngle;
    this.windStrength = strength;
  }

  /** 船头方向单位向量（XZ 平面）。 */
  getForward(out = this._forward) {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /** 右舷方向单位向量。 */
  getRight(out = this._right) {
    // forward=(sin h, cos h)，右转 90°（heading 增加时船从 +Z 转向 +X）得右舷
    return out.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
  }

  /** 对地航速（单位/秒）。 */
  get speed() {
    return this.vel.length();
  }

  /** 航速（节）：按玩法手感换算。 */
  get speedKnots() {
    return this.speed * 0.6;
  }

  /**
   * 计算帆面受风效率。顺风接近满效率、横风约 40%、顶风约 6%；
   * 乘以帆桁朝向匹配度（trim）与帆展开比例。
   * @returns {number} 0..1
   */
  computeSailEfficiency() {
    const f = this.getForward(this._forward);
    this._windTo.set(Math.sin(this.windFrom + Math.PI), Math.cos(this.windFrom + Math.PI));
    const f2 = new THREE.Vector2(f.x, f.z);
    const cosW = f2.dot(this._windTo); // 1=顺风, -1=顶风

    const cross = f2.x * this._windTo.y - f2.y * this._windTo.x;
    const theta = Math.atan2(cross, cosW); // -π..π
    this.windAngleToBoat = theta;
    const absTheta = Math.abs(theta);

    // 基础效率曲线（tail: 0 顶风 .. 1 顺风）
    const tail = (cosW + 1) / 2;
    const base = 0.06 + 0.94 * Math.pow(tail, 1.35);

    // 理想帆桁角：顺风接近垂直船中线，顶风收近中线
    const gammaDeg = 75 - 64 * (absTheta / Math.PI);
    this.idealYard = (theta >= 0 ? 1 : -1) * gammaDeg * DEG;

    // 玩家帆桁与理想值差得越多效率越低（相差 55° 完全失速）
    const trim = THREE.MathUtils.clamp(
      1 - Math.abs(this.idealYard - this.yardAngle) / (55 * DEG), 0, 1
    );
    return THREE.MathUtils.clamp(base * trim, 0, 1);
  }

  /**
   * 固定步长物理更新。
   * @param {number} dt 固定时间步长
   * @param {import('./ocean.js').Ocean} ocean
   * @param {import('./world.js').World} world
   */
  update(dt, ocean, world) {
    // 装填冷却
    if (this.reloadPort > 0) this.reloadPort -= dt;
    if (this.reloadStar > 0) this.reloadStar -= dt;

    // 沉没动画：下沉侧翻
    if (this.sinking) {
      this.sinkTimer += dt;
      this.vel.multiplyScalar(0.9);
      this._syncGroupTransform(ocean, dt, true);
      return;
    }
    if (!this.alive) return;

    const f = this.getForward(this._forward);
    const r = this.getRight(this._right);

    // ---- 帆推力 ----
    this.sailEfficiency = this.computeSailEfficiency();
    let thrust = 0;
    if (!this.anchored) {
      thrust = 52 * this.windStrength * this.sailEfficiency * this.sailAmount;
    }

    // 二维速度积分（x,z）。所有量都按“每秒加速度”计算，再统一乘 dt。
    // 满帆顺风推力≈28.6，转换为加速度 ≈ 8.6 单位/秒²。
    const accel = thrust * 0.3;
    this.vel.x += f.x * accel * dt;
    this.vel.y += f.z * accel * dt;

    // ---- 水阻（线性 + 二次）。稳态 a = drag：
    // 满帆顺风终端速度约 24 单位/秒 ≈ 14 节，时间常数约 7 秒；
    // 顶风推力近乎 0，船迅速失速。 ----
    const spd = this.vel.length();
    if (spd > 0.0001) {
      const drag = 0.08 * spd + 0.012 * spd * spd;
      this.vel.x -= (this.vel.x / spd) * drag * dt;
      this.vel.y -= (this.vel.y / spd) * drag * dt;
    }

    // ---- 横向水阻（船体侧抗），把速度投影到船头方向衰减横向分量 ----
    const vx = this.vel.x;
    const vz = this.vel.y;
    const forwardVel = vx * f.x + vz * f.z;
    const rightVel = vx * r.x + vz * r.z;
    const lateralDamp = Math.exp(-3.2 * dt);
    const keptRight = rightVel * lateralDamp;
    this.vel.x = f.x * forwardVel + r.x * keptRight;
    this.vel.y = f.z * forwardVel + r.z * keptRight;

    // ---- 舵效：转向速率随航速提升，抛锚时几乎不能转 ----
    const speedFactor = THREE.MathUtils.clamp(this.speed / 3.0, 0, 1);
    const anchorFactor = this.anchored ? 0.12 : 1.0;
    this.heading += this.rudder * speedFactor * anchorFactor * 0.95 * dt;

    // ---- 抛锚：快速掉速（风浪中逐渐减速）----
    if (this.anchored) {
      this.vel.multiplyScalar(Math.exp(-1.6 * dt));
    }

    // ---- 位置积分 ----
    this.position.x += this.vel.x * dt;
    this.position.z += this.vel.y * dt;

    // ---- 世界边界（软墙），防止开出有限世界 ----
    const limit = WORLD_HALF - 8;
    const distEdge = Math.hypot(this.position.x, this.position.z);
    if (Math.abs(this.position.x) > limit) {
      this.position.x = Math.sign(this.position.x) * limit;
      this.vel.x *= -0.2;
    }
    if (Math.abs(this.position.z) > limit) {
      this.position.z = Math.sign(this.position.z) * limit;
      this.vel.y *= -0.2;
    }

    // ---- 海底碰撞：搁浅 / 触礁。
    // 水面在 y≈0 附近波动，水深 = 水面 - 海底；船体吃水约 0.9，留 0.5 浪涌余量。 ----
    const terrainH = world.getHeight(this.position.x, this.position.z);
    const keelDepth = 1.4;
    const waterH = ocean.getHeightAt(this.position.x, this.position.z, ocean.time || 0);
    const clearance = waterH - terrainH;
    const wasGrounded = this.grounded;
    this.grounded = clearance < keelDepth;
    if (this.grounded) {
      // 硬地：卡住减速
      this.vel.multiplyScalar(Math.exp(-5.0 * dt));
      // 高速撞上陆地 / 暗礁造成损伤
      if (!wasGrounded && this.speed > 7) {
        this.damage((this.speed - 7) * 4, 'collision');
      }
    }

    this._syncGroupTransform(ocean, dt, false);
  }

  /**
   * 把物理状态同步到 3D 组：位置、航向、波浪浮力、横摇与纵摇。
   * @param {import('./ocean.js').Ocean} ocean
   * @param {number} dt
   * @param {boolean} sinking
   */
  _syncGroupTransform(ocean, dt, sinking) {
    const time = ocean.time || 0;
    const waveH = ocean.getHeightAt(this.position.x, this.position.z, time);

    if (sinking) {
      this.group.position.set(this.position.x, waveH - 0.4 - this.sinkTimer * 1.4, this.position.z);
      this.group.rotation.set(0, this.heading, 0);
      this.group.rotation.z += this.sinkTimer * 0.3;
      return;
    }

    // 采样船头 / 船尾 / 两侧波高，得到纵摇与横摇
    const f = this.getForward(this._forward);
    const r = this.getRight(this._right);
    const halfLen = 3.2;
    const halfWid = 1.6;
    const hBow = ocean.getHeightAt(this.position.x + f.x * halfLen, this.position.z + f.z * halfLen, time);
    const hStern = ocean.getHeightAt(this.position.x - f.x * halfLen, this.position.z - f.z * halfLen, time);
    const hStar = ocean.getHeightAt(this.position.x + r.x * halfWid, this.position.z + r.z * halfWid, time);
    const hPort = ocean.getHeightAt(this.position.x - r.x * halfWid, this.position.z - r.z * halfWid, time);

    const pitchTarget = Math.atan2(hBow - hStern, halfLen * 2);
    const rollTarget = Math.atan2(hStar - hPort, halfWid * 2);

    // 平滑跟随波浪，避免抖动；搁浅时贴地
    const buoyY = this.grounded
      ? Math.max(waveH - 0.55, this.worldGroundY || waveH - 0.55)
      : waveH - 0.55;

    this._pitch = (this._pitch || 0) + (pitchTarget - (this._pitch || 0)) * Math.min(1, dt * 4);
    this._roll = (this._roll || 0) + (rollTarget - (this._roll || 0)) * Math.min(1, dt * 4);

    this.group.position.set(this.position.x, buoyY, this.position.z);
    this.group.rotation.order = 'YXZ';
    this.group.rotation.set(this._pitch, this.heading, this._roll);

    // 帆桁朝向（船坐标系），降帆时把帆缩起
    for (let i = 0; i < this.sailPivots.length; i++) {
      this.sailPivots[i].rotation.y = this.yardAngle;
      this.sailMeshes[i].scale.set(1, Math.max(0.02, this.sailAmount), 1);
    }
    // 舵转动 + 旗帜轻微飘动
    this.rudderMesh.rotation.y = this.rudder * 0.6;
    this.flagMesh.rotation.z = Math.sin(time * 6) * 0.12;
  }

  // ---------- 玩家操控 ----------

  /** 升帆（W）。 */
  raiseSail(dt) {
    if (this.anchored) return;
    this.sailAmount = Math.min(1, this.sailAmount + 0.35 * dt);
  }

  /** 降帆（S）。 */
  lowerSail(dt) {
    this.sailAmount = Math.max(0, this.sailAmount - 0.45 * dt);
  }

  /**
   * 打舵（A/D），舵量自动缓慢回中。
   * @param {number} dir -1 左舵 / +1 右舵
   * @param {number} dt
   */
  setRudderInput(dir, dt) {
    if (dir === 0) {
      // 舵自动回中
      const center = Math.sign(this.rudder) * Math.min(Math.abs(this.rudder), 0.6 * dt);
      this.rudder -= center;
    } else {
      this.rudder = THREE.MathUtils.clamp(this.rudder + dir * 1.8 * dt, -1, 1);
    }
  }

  /** 微调帆桁（Q/E）。 */
  trimYard(dir, dt) {
    this.yardAngle = THREE.MathUtils.clamp(
      this.yardAngle + dir * 0.9 * dt, -80 * DEG, 80 * DEG
    );
  }

  /** 抛锚 / 起锚切换（空格）。 */
  toggleAnchor() {
    this.anchored = !this.anchored;
    if (this.anchored) {
      this.sailAmount = Math.min(this.sailAmount, 0.3);
      this.rudder = 0;
    }
  }

  // ---------- 战斗 ----------

  /**
   * 请求某一舷齐射。
   * @param {'port'|'star'} side
   * @param {number} time
   * @returns {boolean} 是否成功发射（冷却中或沉没则失败）
   */
  requestBroadside(side, time) {
    if (!this.alive || this.sinking) return false;
    const reload = side === 'port' ? this.reloadPort : this.reloadStar;
    if (reload > 0) return false;
    if (side === 'port') this.reloadPort = RELOAD_TIME;
    else this.reloadStar = RELOAD_TIME;
    return true;
  }

  /**
   * 取得某一舷各炮口的世界坐标与发射方向（供战斗系统生成弹道）。
   * @param {'port'|'star'} side
   * @returns {{origin: THREE.Vector3, dir: THREE.Vector3}[]}
   */
  getBroadside(side) {
    const r = this.getRight(this._right.clone());
    const dirVec = r.clone().multiplyScalar(side === 'port' ? -1 : 1);
    const shots = [];
    for (const local of this.muzzles[side]) {
      const origin = local.clone();
      this.group.localToWorld(origin);
      shots.push({ origin, dir: dirVec.clone() });
    }
    return shots;
  }

  /**
   * 承受伤害；耐久归零开始沉没。
   * @param {number} amount
   * @param {string} [cause]
   * @returns {boolean} 本次伤害是否导致沉没
   */
  damage(amount, cause = 'hit') {
    if (!this.alive || this.sinking) return false;
    this.hp = Math.max(0, this.hp - amount);
    this.lastDamageCause = cause;
    if (this.hp <= 0) {
      this.sinking = true;
      this.sinkTimer = 0;
      return true;
    }
    return false;
  }

  /** 沉没动画结束后调用，标记彻底死亡并隐藏模型。 */
  finishSinking() {
    this.alive = false;
    this.group.visible = false;
  }

  /** 从存档恢复或重生时重置位置与状态。 */
  resetState(x, z, heading, hp = this.maxHp) {
    this.position.set(x, 0, z);
    this.vel.set(0, 0);
    this.heading = heading;
    this.hp = hp;
    this.alive = true;
    this.sinking = false;
    this.sinkTimer = 0;
    this.anchored = false;
    this.rudder = 0;
    this.group.visible = true;
    this._pitch = 0;
    this._roll = 0;
  }

  /** 序列化需要持久化的航行状态。 */
  serialize() {
    return {
      x: this.position.x,
      z: this.position.z,
      heading: this.heading,
      hp: this.hp,
      sailAmount: this.sailAmount,
      yardAngle: this.yardAngle,
      anchored: this.anchored
    };
  }

  /** 从存档恢复航行状态。 */
  deserialize(data) {
    this.position.set(data.x, 0, data.z);
    this.heading = data.heading;
    this.hp = data.hp;
    this.sailAmount = data.sailAmount;
    this.yardAngle = data.yardAngle || 0;
    this.anchored = !!data.anchored;
    this.vel.set(0, 0);
  }

  /** 释放 3D 资源（重置世界）。 */
  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      if (obj.isMesh) {
        if (obj.geometry) obj.geometry.dispose();
      }
    });
  }
}
