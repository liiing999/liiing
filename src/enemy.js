// ============================================================
// enemy.js —— 海盗船 AI（无第三方 AI / 寻路库）
// 状态机：巡逻 PATROL → 发现 INVESTIGATE → 追击 CHASE
//         → 侧舷对准 BROADSIDE → 齐射（由 combat 执行）→ 撤退 RETREAT
// AI 决策在固定步长中运行，底层运动复用 ship.js 的自实现动力学。
// ============================================================
import * as THREE from "three";
import { Ship } from "./ship.js";
import { mulberry32 } from "./noise.js";
import { WORLD_HALF } from "./world.js";

export const AI_STATE = {
  PATROL: "巡逻",
  INVESTIGATE: "发现",
  CHASE: "追击",
  BROADSIDE: "侧舷对准",
  RETREAT: "撤退",
};

const _fwd = new THREE.Vector3();
const _toPlayer = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmpV = new THREE.Vector3();

// 敌船配置：按难度缩放
function difficultyConfig(difficulty) {
  return {
    hpMul: 0.85 + difficulty * 0.18,
    sightRange: 170 + difficulty * 22,      // 发现玩家距离
    loseRange: 300 + difficulty * 10,       // 丢失玩家距离
    engageRange: 70 + difficulty * 6,        // 进入炮战距离
    fireRange: 95 + difficulty * 4,
    reload: Math.max(7, 12 - difficulty),
    sailSkill: 0.75 + difficulty * 0.12,    // 操帆熟练度
  };
}

let _enemyId = 1;

export class Enemy {
  /**
   * @param {World} world
   * @param {object} textures 共享船体纹理
   * @param {object} opts { id, x,z,heading, difficulty }
   */
  constructor(world, textures, opts) {
    this.id = opts.id || _enemyId++;
    this.rng = mulberry32(((opts.x * 131) ^ (opts.z * 197) ^ opts.difficulty) >>> 0);
    this.cfg = difficultyConfig(opts.difficulty);

    this.ship = new Ship(world, textures, { pirate: true });
    this.ship.maxHp = Math.round(56 * this.cfg.hpMul);
    this.ship.hp = this.ship.maxHp;
    this.ship.gunReload = this.cfg.reload;
    this.ship.setTransform(opts.x, opts.z, opts.heading);
    this.ship.sailOpen = 0.7;

    // AI 状态
    this.state = AI_STATE.PATROL;
    this.stateTimer = 0;
    this.patrolTarget = new THREE.Vector2(opts.x, opts.z);
    this.patrolWait = 0;
    this.broadsideSide = this.rng() < 0.5 ? -1 : 1; // 偏好侧舷
    this.knowsPlayer = false;
    this.lastPlayerPos = new THREE.Vector3();
    this.firedVolley = false;

    // 冒烟计时（受损后持续冒烟由 combat/main 读取 hp 判断）
  }

  /** 供存档使用的持久 id */
  get key() {
    return "pirate-" + this.id;
  }

  get hpRatio() {
    return this.ship.hp / this.ship.maxHp;
  }

  /** 到玩家的距离 */
  distanceTo(player) {
    return this.ship.position.distanceTo(player.position);
  }

  /**
   * AI 固定步长
   * @param {number} dt
   * @param {Ship} player
   * @param {object} env 风 / 浪环境
   * @param {function(Enemy, number):void} onRequestFire 请求齐射回调（侧舷）
   * @param {function(Enemy):boolean} isPlayerSeen 望远镜 / 视野可见判定（这里仅用距离）
   */
  update(dt, player, env, onRequestFire) {
    if (this.ship.sunk) {
      this.ship.step(dt, env);
      return;
    }

    this.stateTimer += dt;
    const dist = this.distanceTo(player);

    // ----------------------------------------------------------
    // 感知：发现 / 丢失玩家
    // ----------------------------------------------------------
    if (!player.sunk && dist < this.cfg.sightRange) {
      if (!this.knowsPlayer) {
        this.knowsPlayer = true;
        this.state = AI_STATE.INVESTIGATE;
        this.stateTimer = 0;
      }
      this.lastPlayerPos.copy(player.position);
    } else if (this.knowsPlayer && dist > this.cfg.loseRange) {
      this.knowsPlayer = false;
      this.state = AI_STATE.PATROL;
      this.stateTimer = 0;
    }

    // 受损严重 → 撤退
    if (this.hpRatio < 0.32 && this.state !== AI_STATE.RETREAT) {
      this.state = AI_STATE.RETREAT;
      this.stateTimer = 0;
    }

    // ----------------------------------------------------------
    // 各状态行为
    // ----------------------------------------------------------
    switch (this.state) {
      case AI_STATE.PATROL:
        this._doPatrol(dt, env);
        break;
      case AI_STATE.INVESTIGATE:
        // 短暂辨认后转为追击
        this._sailTowards(this.lastPlayerPos.x, this.lastPlayerPos.z, dt, env, 0.85);
        if (this.stateTimer > 2.2) {
          this.state = AI_STATE.CHASE;
          this.stateTimer = 0;
        }
        break;
      case AI_STATE.CHASE:
        this._doChase(dt, player, env);
        break;
      case AI_STATE.BROADSIDE:
        this._doBroadside(dt, player, env, onRequestFire);
        break;
      case AI_STATE.RETREAT:
        this._doRetreat(dt, player, env);
        break;
    }

    // 船体物理
    this.ship.step(dt, env);
  }

  // ----------------------------------------------------------
  // 巡逻：在生成点周围随机选航点
  // ----------------------------------------------------------
  _doPatrol(dt, env) {
    this.patrolWait -= dt;
    const dx = this.patrolTarget.x - this.ship.position.x;
    const dz = this.patrolTarget.y - this.ship.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 14 || this.patrolWait <= 0) {
      // 选一个能航行的深水航点
      for (let tries = 0; tries < 8; tries++) {
        const a = this.rng() * Math.PI * 2;
        const r = 60 + this.rng() * 140;
        const x = this.ship.position.x + Math.cos(a) * r;
        const z = this.ship.position.z + Math.sin(a) * r;
        if (this.ship.world.depthAt(x, z) > 7 && !this.ship.world.outsideWorld(x, z, 30)) {
          this.patrolTarget.set(x, z);
          this.patrolWait = 20 + this.rng() * 30;
          break;
        }
      }
    }
    this._sailTowards(this.patrolTarget.x, this.patrolTarget.y, dt, env, 0.6);
  }

  // ----------------------------------------------------------
  // 追击：逼近玩家，进入射程后转侧舷
  // ----------------------------------------------------------
  _doChase(dt, player, env) {
    const dist = this.distanceTo(player);
    this._sailTowards(player.position.x, player.position.z, dt, env, this.cfg.sailSkill);
    if (dist < this.cfg.fireRange * 0.85) {
      this.state = AI_STATE.BROADSIDE;
      this.stateTimer = 0;
      this.firedVolley = false;
      this.broadsideSide = this.rng() < 0.5 ? -1 : 1;
    }
    // 追丢后回到最后已知位置巡逻
    if (!this.knowsPlayer) {
      this.state = AI_STATE.PATROL;
      this.stateTimer = 0;
    }
  }

  // ----------------------------------------------------------
  // 侧舷对准：让船身与目标垂直，把一舷火炮对准玩家
  // ----------------------------------------------------------
  _doBroadside(dt, player, env, onRequestFire) {
    this.ship.getForward(_fwd);
    _toPlayer.copy(player.position).sub(this.ship.position);
    _toPlayer.y = 0;
    const dist = _toPlayer.length();
    _toPlayer.normalize();

    // 期望船头方向：与“指向玩家的方向”垂直
    _right.set(_fwd.z, 0, -_fwd.x);
    const sideDot = _right.dot(_toPlayer);
    // 如果玩家跑到另一舷，切换侧舷并重新占位
    if ((this.broadsideSide < 0 && sideDot > 0.25) || (this.broadsideSide > 0 && sideDot < -0.25)) {
      this.broadsideSide *= -1;
      this.firedVolley = false;
    }

    // 期望航向：指向玩家方向旋转 ±90°
    const targetAngle = Math.atan2(_toPlayer.x, _toPlayer.z) + this.broadsideSide * Math.PI / 2;
    this._steerToHeading(targetAngle, dt, env);

    // 保持距离：太远靠近，太近后退（这里通过收帆 / 反向转向风筝）
    if (dist > this.cfg.fireRange * 0.9) {
      this.ship.sailOpen = Math.min(1, this.ship.sailOpen + dt * 0.4);
    } else if (dist < 32) {
      this.ship.sailOpen = Math.max(0.05, this.ship.sailOpen - dt * 0.8);
    } else {
      this.ship.sailOpen += (0.55 * this.cfg.sailSkill - this.ship.sailOpen) * dt * 0.5;
    }

    // 侧舷大致对准（船头与目标方向近似垂直）且在射程内 → 请求齐射
    const alignment = Math.abs(_fwd.dot(_toPlayer)); // 接近 0 即侧舷对准
    if (alignment < 0.28 && dist < this.cfg.fireRange && !player.sunk) {
      if (!this.firedVolley) {
        if (this.ship.canFire(this.broadsideSide)) {
          onRequestFire(this, this.broadsideSide);
          this.ship.markFired(this.broadsideSide);
        }
        this.firedVolley = true;
      }
    } else if (alignment > 0.5) {
      this.firedVolley = false;
    }

    // 玩家脱离射程太远 → 重新追击
    if (dist > this.cfg.fireRange * 1.25) {
      this.state = AI_STATE.CHASE;
      this.stateTimer = 0;
    }
    // 规避：前方有陆地就转向
    this._avoidGround(dt, env);
  }

  // ----------------------------------------------------------
  // 撤退：朝远离玩家、且是深水的方向逃跑
  // ----------------------------------------------------------
  _doRetreat(dt, player, env) {
    _tmpV.copy(this.ship.position).sub(player.position);
    _tmpV.y = 0;
    if (_tmpV.lengthSq() < 1) _tmpV.set(Math.cos(this.ship.heading), 0, Math.sin(this.ship.heading));
    _tmpV.normalize();
    // 略微抖动，避免直线搁浅
    const a = Math.atan2(_tmpV.x, _tmpV.z) + Math.sin(this.stateTimer * 0.4) * 0.4;
    const tx = this.ship.position.x + Math.sin(a) * 200;
    const tz = this.ship.position.z + Math.cos(a) * 200;
    this._sailTowards(tx, tz, dt, env, 0.95);
    // 脱战足够久（血量低仍不返回，只逃跑）
    if (this.distanceTo(player) > this.cfg.loseRange) this.knowsPlayer = false;
  }

  // ----------------------------------------------------------
  // 共用驾驶辅助
  // ----------------------------------------------------------
  /** 朝某个世界坐标航行：操帆 + 打舵（自动避开陆地） */
  _sailTowards(x, z, dt, env, sailSkill) {
    const desired = Math.atan2(x - this.ship.position.x, z - this.ship.position.z);
    this._steerToHeading(desired, dt, env);
    const targetOpen = this.knowsPlayer ? sailSkill : 0.55;
    this.ship.sailOpen += (targetOpen - this.ship.sailOpen) * dt * 0.6;
    this._avoidGround(dt, env);
  }

  /** 打舵使船头转向指定 yaw（自动选择左右短弧） */
  _steerToHeading(target, dt) {
    let diff = target - this.ship.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const rudder = THREE.MathUtils.clamp(diff * 2.2, -1, 1);
    this.ship.setRudder(rudder);
  }

  /** 前方 / 侧前方水深不足时提前转向，防止 AI 撞岛 */
  _avoidGround(dt) {
    this.ship.getForward(_fwd);
    const probe = 16;
    const hx = this.ship.position.x + _fwd.x * probe;
    const hz = this.ship.position.z + _fwd.z * probe;
    const depth = this.ship.world.depthAt(hx, hz);
    if (depth < 4.5 || this.ship.world.outsideWorld(hx, hz, 24)) {
      // 选左 / 右中更深的一侧
      _right.set(_fwd.z, 0, -_fwd.x);
      const lx = this.ship.position.x + (_fwd.x * 0.6 + _right.x) * probe;
      const lz = this.ship.position.z + (_fwd.z * 0.6 + _right.z) * probe;
      const rx = this.ship.position.x + (_fwd.x * 0.6 - _right.x) * probe;
      const rz = this.ship.position.z + (_fwd.z * 0.6 - _right.z) * probe;
      const dl = this.ship.world.depthAt(lx, lz);
      const dr = this.ship.world.depthAt(rx, rz);
      this.ship.setRudder(dl > dr ? -1 : 1);
    }
  }
}

// ============================================================
// EnemyManager：程序化生成 3~6 艘海盗船，管理发现 / 击沉 / 存档
// ============================================================
export class EnemyManager {
  /**
   * @param {World} world
   * @param {THREE.Scene} scene
   * @param {object} textures 共享船体纹理
   * @param {{count?:number}} opts
   */
  constructor(world, scene, textures, opts = {}) {
    this.world = world;
    this.scene = scene;
    this.textures = textures;
    this.enemies = [];
    this.discovered = new Set();   // 玩家已发现的敌船 id
    this.rng = mulberry32((world.seed ^ 0x9e3779b9) >>> 0);

    const count = opts.count != null ? opts.count : 3 + Math.floor(this.rng() * 4);
    this.totalCount = Math.max(3, Math.min(6, count));
  }

  /** 在远离玩家的深水区生成海盗（startX/Z 为玩家出生点） */
  spawn(startX, startZ, restored = null) {
    let placed = 0;
    let attempts = 0;
    const used = [];
    while (placed < this.totalCount && attempts < 600) {
      attempts++;
      const a = this.rng() * Math.PI * 2;
      const r = 230 + this.rng() * 150;
      const x = THREE.MathUtils.clamp(startX + Math.cos(a) * r, -WORLD_LIMIT, WORLD_LIMIT);
      const z = THREE.MathUtils.clamp(startZ + Math.sin(a) * r, -WORLD_LIMIT, WORLD_LIMIT);
      if (this.world.depthAt(x, z) < 9) continue;
      let tooClose = false;
      for (const u of used) {
        if (Math.hypot(u.x - x, u.z - z) < 120) { tooClose = true; break; }
      }
      if (tooClose) continue;
      used.push({ x, z });

      const difficulty = 1 + Math.floor(this.rng() * 3); // 1~3
      const heading = this.rng() * Math.PI * 2;
      const enemy = new Enemy(this.world, this.textures, { id: placed + 1, x, z, heading, difficulty });

      // 恢复存档
      if (restored && restored[enemy.key]) {
        const d = restored[enemy.key];
        enemy.ship.setTransform(d.x, d.z, d.heading);
        enemy.ship.hp = d.hp;
        enemy.ship.sailOpen = d.sailOpen;
        if (d.sunk) enemy.ship.sink();
      }

      this.enemies.push(enemy);
      this.scene.add(enemy.ship.group);
      placed++;
    }
    this.totalCount = this.enemies.length;
  }

  /**
   * 固定步长更新全部海盗
   * @param {Ship} player
   * @param {object} env
   * @param {function(Enemy,number):void} onFire AI 请求齐射
   */
  update(dt, player, env, onFire) {
    for (const enemy of this.enemies) {
      enemy.update(dt, player, env, onFire);
    }
  }

  /** 玩家通过视野 / 望远镜发现敌船（每帧调用） */
  refreshDiscovery(player, camera, fovRatio) {
    for (const enemy of this.enemies) {
      if (enemy.ship.sunk || this.discovered.has(enemy.id)) continue;
      const dist = enemy.distanceTo(player);
      // 望远镜视距更远
      const range = fovRatio > 1.2 ? 420 : 240;
      if (dist < range) this.discovered.add(enemy.id);
    }
  }

  /** 手动标记发现（炮弹交火必然暴露） */
  discover(enemy) {
    this.discovered.add(enemy.id);
  }

  get aliveEnemies() {
    return this.enemies.filter((e) => !e.ship.sunk);
  }
  get sunkCount() {
    return this.enemies.filter((e) => e.ship.sunk).length;
  }

  /** 调试面板用的状态行 */
  statusLines() {
    return this.enemies.map((e) => {
      const hp = Math.ceil(e.ship.hp);
      const known = this.discovered.has(e.id) ? "已发现" : "未知";
      let dist = "-";
      if (this._debugPlayer) {
        dist = e.ship.position.distanceTo(this._debugPlayer.position).toFixed(0) + "m";
      }
      return `#${e.id} ${e.state} ${e.stateTimer.toFixed(0)}s 距${dist} HP${hp} [${known}]`;
    });
  }

  /** main 每帧注入玩家引用，供调试行显示距离 */
  setDebugPlayer(player) {
    this._debugPlayer = player;
  }

  serialize() {
    const list = {};
    for (const e of this.enemies) {
      list[e.key] = e.ship.serialize();
      list[e.key].sunk = e.ship.sunk;
    }
    return {
      enemies: list,
      discovered: [...this.discovered],
    };
  }

  deserialize(data) {
    if (!data) return;
    if (Array.isArray(data.discovered)) {
      this.discovered = new Set(data.discovered);
    }
  }

  dispose() {
    for (const e of this.enemies) this.scene.remove(e.ship.group);
    this.enemies.length = 0;
  }
}

const WORLD_LIMIT = WORLD_HALF - 24;
