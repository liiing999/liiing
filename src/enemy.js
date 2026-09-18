// enemy.js —— 海盗舰队与状态机 AI（不使用任何第三方 AI / 寻路库）。
// 状态：patrol 巡逻 → discover 发现 → chase 追击 → broadside 侧舷对准
//       → fire 齐射；耐久过低进入 flee 撤退。

import * as THREE from 'three';
import { Ship } from './ship.js';
import { mulberry32 } from './noise.js';
import { WORLD_HALF } from './world.js';

const DEG = Math.PI / 180;

const STATE_LABEL = {
  patrol: '巡逻',
  discover: '发现',
  chase: '追击',
  broadside: '侧舷对准',
  fire: '齐射',
  flee: '撤退'
};

/** 角度差归一化到 -π..π */
function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * 单个海盗船及其 AI 状态。
 */
class EnemyShip {
  /**
   * @param {THREE.Scene} scene
   * @param {{x:number,z:number,heading:number}} config
   */
  constructor(scene, config) {
    this.ship = new Ship(scene, { isEnemy: true, maxHp: 70, scale: 0.92 });
    this.ship.position.set(config.x, 0, config.z);
    this.ship.heading = config.heading;

    this.state = 'patrol';
    this.stateTime = 0;
    this.patrolTarget = new THREE.Vector2(config.x, config.z);
    this.patrolTimer = 0;
    this.discovered = false; // 是否已被玩家发现
    this.fireCooldown = 4 + Math.random() * 3;
    this.broadsideSide = Math.random() > 0.5 ? 'port' : 'star';
    this.retreatPoint = null;
    this.fleeTimer = 0;
  }

  get label() {
    return STATE_LABEL[this.state] || this.state;
  }
}

/**
 * 海盗舰队。
 */
export class EnemyFleet {
  /**
   * @param {THREE.Scene} scene
   * @param {number} seed
   * @param {number} count 海盗船数量（3..6）
   * @param {import('./world.js').World} world
   */
  constructor(scene, seed, count, world) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.world = world;
    this.enemies = [];
    // 待发射队列：{ ship, side }，由主循环交给 Combat
    this.pendingFires = [];
    this._generate(count);
  }

  /** 在远离出生点、且水深足够的位置确定性生成海盗船。 */
  _generate(count) {
    const rand = mulberry32(this.seed ^ 0x5151);
    let attempts = 0;
    while (this.enemies.length < count && attempts < 300) {
      attempts++;
      const x = (rand() * 2 - 1) * (WORLD_HALF - 60);
      const z = (rand() * 2 - 1) * (WORLD_HALF - 60);
      if (Math.hypot(x, z) < 190) continue;
      if (this.world.getHeight(x, z) > -3) continue;
      let ok = true;
      for (const e of this.enemies) {
        if (Math.hypot(x - e.ship.position.x, z - e.ship.position.z) < 120) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      this.enemies.push(new EnemyShip(this.scene, { x, z, heading: rand() * Math.PI * 2 }));
    }
  }

  /** 所有海盗船（含已沉没占位）。 */
  get ships() {
    return this.enemies.map((e) => e.ship);
  }

  /** 设置风环境。 */
  setWind(fromAngle, strength) {
    for (const e of this.enemies) e.ship.setWind(fromAngle, strength);
  }

  /**
   * 朝目标点航行所需的舵输入。
   * @param {EnemyShip} enemy
   * @param {number} tx
   * @param {number} tz
   * @returns {number}
   */
  _steerToward(enemy, tx, tz) {
    const s = enemy.ship;
    const desired = Math.atan2(tx - s.position.x, tz - s.position.z);
    const diff = angleDelta(desired, s.heading);
    return THREE.MathUtils.clamp(diff * 2.2, -1, 1);
  }

  /**
   * 计算用哪一舷朝向玩家时，当前航向与“侧舷对敌航向”的误差（弧度）。
   * @param {import('./ship.js').Ship} s
   * @param {import('./ship.js').Ship} player
   * @returns {number}
   */
  _broadsideAngleError(s, player) {
    const dx = player.position.x - s.position.x;
    const dz = player.position.z - s.position.z;
    const angleToPlayer = Math.atan2(dx, dz);
    // 侧舷对敌意味着航向与“指向玩家方向”相差 ±90°
    const errPort = Math.abs(angleDelta(s.heading, angleToPlayer - Math.PI / 2));
    const errStar = Math.abs(angleDelta(s.heading, angleToPlayer + Math.PI / 2));
    return Math.min(errPort, errStar);
  }

  /** 选择更接近对准玩家的那一舷。 */
  _chooseBroadsideSide(s, player) {
    const dx = player.position.x - s.position.x;
    const dz = player.position.z - s.position.z;
    const angleToPlayer = Math.atan2(dx, dz);
    const errPort = Math.abs(angleDelta(s.heading, angleToPlayer - Math.PI / 2));
    return errPort < Math.abs(angleDelta(s.heading, angleToPlayer + Math.PI / 2)) ? 'port' : 'star';
  }

  /**
   * 驶成侧舷对敌的平行航向。
   * @param {EnemyShip} enemy
   * @param {import('./ship.js').Ship} player
   * @returns {number}
   */
  _steerBroadside(enemy, player) {
    const s = enemy.ship;
    const dx = player.position.x - s.position.x;
    const dz = player.position.z - s.position.z;
    const dist = Math.hypot(dx, dz);
    const angleToPlayer = Math.atan2(dx, dz);
    const sign = enemy.broadsideSide === 'port' ? -1 : 1;
    const desired = angleToPlayer + sign * Math.PI / 2;
    const diff = angleDelta(desired, s.heading);
    let radialBias = 0;
    if (dist < 38) radialBias = sign * 0.5;
    else if (dist > 80) radialBias = -sign * 0.5;
    return THREE.MathUtils.clamp(diff * 2.0 + radialBias, -1, 1);
  }

  /**
   * 沿连线步进采样若干点，若中间有高出水面的陆地则判定无视线。
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3} to
   * @param {import('./world.js').World} world
   * @returns {boolean}
   */
  _hasLineOfSight(from, to, world) {
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.min(8, Math.floor(dist / 24));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const z = from.z + (to.z - from.z) * t;
      if (world.getHeight(x, z) > 1.5) return false;
    }
    return true;
  }

  /** 简单船间排斥分离，避免海盗船重叠。 */
  _separate(enemy) {
    const s = enemy.ship;
    for (const other of this.enemies) {
      if (other === enemy || !other.ship.alive) continue;
      const dx = s.position.x - other.ship.position.x;
      const dz = s.position.z - other.ship.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.001 && d < 8) {
        const push = (8 - d) * 0.3;
        s.position.x += (dx / d) * push;
        s.position.z += (dz / d) * push;
      }
    }
  }

  /**
   * 更新所有海盗 AI（固定步长）。
   * @param {number} dt
   * @param {import('./ship.js').Ship} player
   * @param {import('./ocean.js').Ocean} ocean
   * @param {import('./world.js').World} world
   * @param {{spyglass:boolean, onDiscover?:(e:EnemyShip)=>void}} sense
   */
  update(dt, player, ocean, world, sense) {
    this.pendingFires.length = 0;

    for (const enemy of this.enemies) {
      const s = enemy.ship;
      if (!s.alive) continue;
      enemy.stateTime += dt;
      enemy.patrolTimer -= dt;
      enemy.fireCooldown -= dt;

      const dx = player.position.x - s.position.x;
      const dz = player.position.z - s.position.z;
      const dist = Math.hypot(dx, dz);

      // AI 自动调帆桁到理想角，保证高航行效率
      s.sailEfficiency = s.computeSailEfficiency();
      s.yardAngle += (s.idealYard - s.yardAngle) * Math.min(1, dt * 2);

      // 沉没动画结束后移除
      if (s.sinking) {
        if (enemy.stateTime > 3.2 && s.alive) s.finishSinking();
        continue;
      }

      // 受损过重 => 撤退
      if (s.hp < 18 && enemy.state !== 'flee') {
        enemy.state = 'flee';
        enemy.stateTime = 0;
        enemy.fleeTimer = 14;
        const away = Math.atan2(-dx, -dz);
        enemy.retreatPoint = new THREE.Vector2(
          THREE.MathUtils.clamp(s.position.x + Math.sin(away) * 160, -WORLD_HALF + 30, WORLD_HALF - 30),
          THREE.MathUtils.clamp(s.position.z + Math.cos(away) * 160, -WORLD_HALF + 30, WORLD_HALF - 30)
        );
      }

      const canSee = dist < 300 && this._hasLineOfSight(s.position, player.position, world);

      let rudderInput = 0;
      if (enemy.state === 'patrol') {
        s.sailAmount += (0.75 - s.sailAmount) * dt;
        if (enemy.patrolTimer <= 0 ||
          Math.hypot(enemy.patrolTarget.x - s.position.x, enemy.patrolTarget.y - s.position.z) < 24) {
          enemy.patrolTimer = 12 + Math.random() * 10;
          enemy.patrolTarget.set(
            THREE.MathUtils.clamp(s.position.x + (Math.random() - 0.5) * 220, -WORLD_HALF + 40, WORLD_HALF - 40),
            THREE.MathUtils.clamp(s.position.z + (Math.random() - 0.5) * 220, -WORLD_HALF + 40, WORLD_HALF - 40)
          );
        }
        rudderInput = this._steerToward(enemy, enemy.patrolTarget.x, enemy.patrolTarget.y);
        if (canSee && dist < 210) {
          enemy.state = 'discover';
          enemy.stateTime = 0;
        }
      } else if (enemy.state === 'discover') {
        s.sailAmount += (1 - s.sailAmount) * dt * 2;
        rudderInput = this._steerToward(enemy, player.position.x, player.position.z);
        if (enemy.stateTime > 1.4) {
          enemy.state = 'chase';
          enemy.stateTime = 0;
        }
        if (!canSee && enemy.stateTime > 3) {
          enemy.state = 'patrol';
          enemy.stateTime = 0;
        }
      } else if (enemy.state === 'chase') {
        s.sailAmount += (1 - s.sailAmount) * dt * 2;
        rudderInput = this._steerToward(enemy, player.position.x, player.position.z);
        if (dist < 110 && canSee) {
          enemy.state = 'broadside';
          enemy.stateTime = 0;
          enemy.broadsideSide = this._chooseBroadsideSide(s, player);
        }
        if (dist > 320 || !canSee) {
          enemy.state = 'patrol';
          enemy.stateTime = 0;
        }
      } else if (enemy.state === 'broadside') {
        s.sailAmount += (0.6 - s.sailAmount) * dt;
        rudderInput = this._steerBroadside(enemy, player);
        const ready = this._broadsideAngleError(s, player) < 18 * DEG && dist < 120 && canSee;
        if (ready && enemy.fireCooldown <= 0) {
          enemy.state = 'fire';
          enemy.stateTime = 0;
        }
        if (dist > 150) {
          enemy.state = 'chase';
          enemy.stateTime = 0;
        }
      } else if (enemy.state === 'fire') {
        s.sailAmount += (0.2 - s.sailAmount) * dt;
        rudderInput = this._steerBroadside(enemy, player);
        if (enemy.stateTime < 0.15) {
          if (s.requestBroadside(enemy.broadsideSide, ocean.time || 0)) {
            this.pendingFires.push({ ship: s, side: enemy.broadsideSide });
            enemy.fireCooldown = 7 + Math.random() * 3;
          }
        }
        if (enemy.stateTime > 1.2) {
          enemy.state = 'broadside';
          enemy.stateTime = 0;
        }
      } else if (enemy.state === 'flee') {
        s.sailAmount += (1 - s.sailAmount) * dt * 2;
        if (enemy.retreatPoint) {
          rudderInput = this._steerToward(enemy, enemy.retreatPoint.x, enemy.retreatPoint.y);
        }
        enemy.fleeTimer -= dt;
        if (dist < 70 && canSee && this._broadsideAngleError(s, player) < 15 * DEG && enemy.fireCooldown <= 0) {
          const side = this._chooseBroadsideSide(s, player);
          if (s.requestBroadside(side, ocean.time || 0)) {
            this.pendingFires.push({ ship: s, side });
            enemy.fireCooldown = 8;
          }
        }
        // 撤退一段时间后进入游荡，避免一直堆在边界
        if (enemy.fleeTimer <= 0) {
          enemy.state = 'patrol';
          enemy.stateTime = 0;
          enemy.patrolTimer = 0;
        }
      }

      s.setRudderInput(rudderInput, dt);
      s.update(dt, ocean, world);
      this._separate(enemy);

      // 发现机制：进入玩家视野 / 望远镜范围才标记
      if (!enemy.discovered) {
        const visionRange = sense.spyglass ? 320 : 170;
        if (dist < visionRange && canSee) {
          enemy.discovered = true;
          if (sense.onDiscover) sense.onDiscover(enemy);
        }
      }
    }
  }

  /**
   * 供调试面板显示的 AI 状态。
   * @returns {Array<{index:number,state:string,hp:number,dist:number,discovered:boolean,alive:boolean}>}
   */
  getDebugStates(player) {
    return this.enemies.map((enemy, index) => {
      const s = enemy.ship;
      const dist = Math.hypot(player.position.x - s.position.x, player.position.z - s.position.z);
      return {
        index,
        state: enemy.label,
        hp: Math.round(s.hp),
        dist: Math.round(dist),
        discovered: enemy.discovered,
        alive: s.alive
      };
    });
  }

  /** 已击沉的海盗船索引（用于计分与存档）。 */
  get sunkIndices() {
    const result = [];
    this.enemies.forEach((e, i) => {
      if (!e.ship.alive) result.push(i);
    });
    return result;
  }

  /** 已被发现的海盗船索引。 */
  get discoveredIndices() {
    const result = [];
    this.enemies.forEach((e, i) => {
      if (e.discovered) result.push(i);
    });
    return result;
  }

  /** 从存档恢复已击沉 / 已发现集合。 */
  restoreState(sunkIndices = [], discoveredIndices = []) {
    sunkIndices.forEach((i) => {
      if (this.enemies[i]) {
        const s = this.enemies[i].ship;
        s.hp = 0;
        s.alive = false;
        s.group.visible = false;
      }
    });
    discoveredIndices.forEach((i) => {
      if (this.enemies[i]) this.enemies[i].discovered = true;
    });
  }

  /** 释放全部海盗船资源。 */
  dispose() {
    for (const e of this.enemies) e.ship.dispose();
    this.enemies = [];
  }
}
