// combat.js —— 两舷火炮齐射、炮弹弹道积分（重力 + 简化空气阻力）、
// 入水柱 / 跳弹、球体命中判定、炮口火光与烟雾特效。
// 炮弹使用固定大小的 InstancedMesh 池，特效使用固定 Sprite 池，避免 GC 抖动。

import * as THREE from 'three';
import { getTextures } from './textures.js';

const GRAVITY = 18.0;
const BALL_SPEED = 92;
const MAX_PROJECTILES = 80;
const MAX_EFFECTS = 90;

/**
 * 海战系统。
 */
export class Combat {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.time = 0;

    // 炮弹对象池（逻辑数组）
    this.projectiles = [];
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.projectiles.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        owner: null,      // 发射方 Ship
        faction: 'player',
        bounces: 0,
        age: 0
      });
    }

    // 炮弹 InstancedMesh
    const ballGeo = new THREE.SphereGeometry(0.28, 6, 5);
    const ballMat = new THREE.MeshLambertMaterial({ color: 0x17181a });
    this.ballMesh = new THREE.InstancedMesh(ballGeo, ballMat, MAX_PROJECTILES);
    this.ballMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ballMesh.count = MAX_PROJECTILES;
    this.ballMesh.frustumCulled = false;
    // 未使用的炮弹缩放到 0
    this._zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX_PROJECTILES; i++) this.ballMesh.setMatrixAt(i, this._zeroMatrix);
    this.ballMesh.instanceMatrix.needsUpdate = true;
    scene.add(this.ballMesh);

    // 特效池（水柱、烟雾、火光）
    const tex = getTextures();
    this.effects = [];
    for (let i = 0; i < MAX_EFFECTS; i++) {
      const material = new THREE.SpriteMaterial({
        map: tex.splash, transparent: true, opacity: 0, depthWrite: false
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 5;
      scene.add(sprite);
      this.effects.push({
        active: false, sprite,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        life: 0, maxLife: 1, baseScale: 1,
        kind: 'splash', grow: 1
      });
    }

    this._dummy = new THREE.Object3D();

    // 事件回调：命中 / 击沉，由主程序赋值用于提示与计分
    this.onHit = null;
    this.onSunk = null;
  }

  /**
   * 从一舷的若干炮口齐射。
   * @param {import('./ship.js').Ship} ship
   * @param {'port'|'star'} side
   */
  fireBroadside(ship, side) {
    const shots = ship.getBroadside(side);
    for (const shot of shots) {
      const p = this.projectiles.find((item) => !item.active);
      if (!p) break;
      p.active = true;
      p.owner = ship;
      p.faction = ship.isEnemy ? 'enemy' : 'player';
      p.pos.copy(shot.origin);
      // 初速：沿炮口方向 + 少量仰角与散射
      const spread = (Math.random() - 0.5) * 0.05;
      const dir = shot.dir.clone();
      dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), spread);
      dir.y = 0.16 + Math.random() * 0.06; // 仰角
      dir.normalize();
      p.vel.copy(dir).multiplyScalar(BALL_SPEED);
      p.bounces = 0;
      p.age = 0;
      this._spawnEffect(shot.origin, 'flash', 0.18, 1.6);
      this._spawnEffect(shot.origin, 'smoke', 0.7, 1.2);
    }
  }

  /**
   * 生成一个特效精灵。
   * @param {THREE.Vector3} pos
   * @param {'splash'|'smoke'|'flash'|'hit'} kind
   * @param {number} life
   * @param {number} scale
   */
  _spawnEffect(pos, kind, life, scale) {
    const e = this.effects.find((item) => !item.active);
    if (!e) return;
    const tex = getTextures();
    const map = kind === 'splash' ? tex.splash : kind === 'flash' || kind === 'hit' ? tex.flash : tex.smoke;
    e.sprite.material.map = map;
    e.sprite.material.needsUpdate = true;
    e.active = true;
    e.sprite.visible = true;
    e.pos.copy(pos);
    e.kind = kind;
    e.life = life;
    e.maxLife = life;
    e.baseScale = scale;
    e.grow = kind === 'smoke' ? 2.2 : kind === 'splash' ? 1.8 : 0.6;
    e.vel.set(
      (Math.random() - 0.5) * 0.6,
      kind === 'smoke' ? 1.6 : kind === 'splash' ? 2.2 : 0,
      (Math.random() - 0.5) * 0.6
    );
    e.sprite.position.copy(pos);
    e.sprite.scale.setScalar(scale);
  }

  /**
   * 固定步长更新所有炮弹与特效。
   * @param {number} dt
   * @param {import('./ocean.js').Ocean} ocean
   * @param {import('./world.js').World} world
   * @param {Array<import('./ship.js').Ship>} targets
   */
  update(dt, ocean, world, targets) {
    this.time += dt;

    // ---- 炮弹弹道积分 ----
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.age += dt;

      // 重力
      p.vel.y -= GRAVITY * dt;
      // 简化空气阻力
      p.vel.multiplyScalar(1 - 0.045 * dt);
      p.pos.addScaledVector(p.vel, dt);

      const waterH = ocean.getHeightAt(p.pos.x, p.pos.z, this.time);
      const terrainH = world.getHeight(p.pos.x, p.pos.z);

      // 撞到岛上 / 礁石
      if (p.pos.y < terrainH && terrainH > 0) {
        this._spawnEffect(p.pos, 'hit', 0.4, 2.2);
        p.active = false;
        continue;
      }

      // 入水
      if (p.pos.y <= waterH) {
        // 高速且入射角平缓 => 跳弹
        const horizontalSpeed = Math.hypot(p.vel.x, p.vel.z);
        const shallowImpact = p.vel.y > -14;
        if (p.bounces < 1 && horizontalSpeed > 30 && shallowImpact) {
          p.bounces++;
          p.pos.y = waterH + 0.2;
          p.vel.y = Math.abs(p.vel.y) * 0.45 + 6;
          p.vel.multiplyScalar(0.72);
          this._spawnEffect(p.pos, 'splash', 0.6, 2.0);
        } else {
          this._spawnEffect(p.pos, 'splash', 0.8, 3.2);
          p.active = false;
          continue;
        }
      }

      // 寿命上限
      if (p.age > 6) {
        p.active = false;
        continue;
      }

      // 命中判定（球体）：只命中敌对阵营且仍存活的船
      for (const target of targets) {
        if (!target.alive || target.sinking || target === p.owner) continue;
        const targetIsEnemy = target.isEnemy;
        if ((p.faction === 'enemy') === targetIsEnemy) continue; // 同阵营免伤
        const dx = p.pos.x - target.position.x;
        const dz = p.pos.z - target.position.z;
        const distXZ = Math.hypot(dx, dz);
        const hitRadius = 2.6 * target.modelScale;
        if (distXZ < hitRadius && p.pos.y < 5.5 * target.modelScale && p.pos.y > -2) {
          const sunk = target.damage(14, 'cannonball');
          this._spawnEffect(p.pos, 'hit', 0.45, 2.6);
          this._spawnEffect(p.pos, 'smoke', 0.9, 2.0);
          if (this.onHit) this.onHit(target, p.faction);
          if (sunk && this.onSunk) this.onSunk(target, p.faction);
          p.active = false;
          break;
        }
      }
    }

    // 同步 InstancedMesh 矩阵
    for (let i = 0; i < this.projectiles.length; i++) {
      const p = this.projectiles[i];
      if (p.active) {
        this._dummy.position.copy(p.pos);
        this._dummy.scale.setScalar(1);
        this._dummy.updateMatrix();
        this.ballMesh.setMatrixAt(i, this._dummy.matrix);
      } else {
        this.ballMesh.setMatrixAt(i, this._zeroMatrix);
      }
    }
    this.ballMesh.instanceMatrix.needsUpdate = true;

    // ---- 特效更新 ----
    for (const e of this.effects) {
      if (!e.active) continue;
      e.life -= dt;
      if (e.life <= 0) {
        e.active = false;
        e.sprite.visible = false;
        continue;
      }
      e.pos.addScaledVector(e.vel, dt);
      if (e.kind === 'smoke') e.vel.multiplyScalar(0.96);
      const t = 1 - e.life / e.maxLife;
      const scale = e.baseScale * (1 + e.grow * t);
      e.sprite.position.copy(e.pos);
      e.sprite.scale.setScalar(scale);
      e.sprite.material.opacity = (e.kind === 'flash' ? 1 : 0.85) * (1 - t);
    }
  }

  /**
   * 在受损船只身上持续生成黑烟（由主循环按损伤程度调用）。
   * @param {import('./ship.js').Ship} ship
   * @param {number} dt
   */
  emitDamageSmoke(ship, dt) {
    if (!ship.alive || ship.sinking) return;
    ship._smokeAcc = (ship._smokeAcc || 0) + dt;
    const damageRatio = 1 - ship.hp / ship.maxHp;
    const interval = 1.2 - damageRatio * 0.9; // 伤越重烟越密
    if (ship._smokeAcc > interval) {
      ship._smokeAcc = 0;
      const pos = new THREE.Vector3(
        ship.position.x + (Math.random() - 0.5) * 2,
        5.5 + Math.random(),
        ship.position.z + (Math.random() - 0.5) * 2
      );
      this._spawnEffect(pos, 'smoke', 1.4, 1.6);
    }
  }

  /** 释放资源。 */
  dispose() {
    this.scene.remove(this.ballMesh);
    this.ballMesh.geometry.dispose();
    this.ballMesh.material.dispose();
    for (const e of this.effects) {
      this.scene.remove(e.sprite);
      e.sprite.material.dispose();
    }
  }
}
