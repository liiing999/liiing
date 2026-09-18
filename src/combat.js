// ============================================================
// combat.js —— 两舷火炮、弹道积分、水柱 / 跳弹、命中与冒烟
// 炮弹受重力 + 简化空气阻力，自行积分；全部特效对象池化。
// ============================================================
import * as THREE from "three";
import { waveHeight } from "./ocean.js";
import { makeFoamTexture, makeSmokeTexture, makeFlashTexture } from "./textures.js";

const GRAVITY = 9.81;
const AIR_DRAG = 0.045;
const BALL_RADIUS = 0.22;
const PLAYER_BALL_DMG = 13;
const ENEMY_BALL_DMG = 8;
const RICOCHET_CHANCE = 0.35;

const _v = new THREE.Vector3();
const ZERO_VEC = new THREE.Vector3();

export class CombatSystem {
  constructor(scene, world, textures = {}) {
    this.scene = scene;
    this.world = world;
    this.maxBalls = 160;
    this.balls = [];

    // 炮弹 InstancedMesh
    const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 8, 6);
    const ballMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.5, metalness: 0.4 });
    this.ballMesh = new THREE.InstancedMesh(ballGeo, ballMat, this.maxBalls);
    this.ballMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ballMesh.frustumCulled = false;
    this.ballMesh.count = 0;
    this.scene.add(this.ballMesh);

    // 粒子：水柱(foam) / 烟雾(smoke) / 火光(flash)
    this.maxParticles = 220;
    this.particles = [];
    const pGeo = new THREE.PlaneGeometry(1, 1);
    const defs = {
      foam: { tex: textures.foam || makeFoamTexture(), color: 0xffffff },
      smoke: { tex: textures.smoke || makeSmokeTexture(), color: 0xffffff },
      flash: { tex: textures.flash || makeFlashTexture(), color: 0xffd9a0 },
    };
    this.particleMeshes = {};
    for (const key of Object.keys(defs)) {
      const mat = new THREE.MeshBasicMaterial({
        map: defs[key].tex,
        color: defs[key].color,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    const mesh = new THREE.InstancedMesh(pGeo, mat, this.maxParticles);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.scene.add(mesh);
    this.particleMeshes[key] = mesh;
  }
  // 初始化所有实例颜色（此时 instanceColor 缓冲确定已创建）
  const white = new THREE.Color(1, 1, 1);
  for (const key of Object.keys(this.particleMeshes)) {
    for (let i = 0; i < this.maxParticles; i++) this.particleMeshes[key].setColorAt(i, white);
  }
    for (let i = 0; i < this.maxParticles; i++) {
      this.particles.push({
      active: false, type: "foam",
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        age: 0, life: 1, size: 1, grow: 0, fade: true,
      });
    }

    for (let i = 0; i < this.maxBalls; i++) {
      this.balls.push({
        active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        age: 0, fromPlayer: true, damage: 0, ricochets: 0,
      });
    }

    this.events = { splash: 0, playerHit: 0, enemyHit: 0, enemySunk: 0, playerSunk: false };
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
  }

  /** 一舷齐射（炮口位置 / 方向由外部按船体算出） */
  fireBroadside(shooter, side, fromPlayer, muzzlesPos, muzzlesDir) {
    for (let i = 0; i < muzzlesPos.length; i++) {
      const ball = this._getFreeBall();
      if (!ball) break;
      ball.active = true;
      ball.pos.copy(muzzlesPos[i]);
      _v.copy(muzzlesDir[i]);
      _v.x += (Math.random() - 0.5) * 0.045;
      _v.z += (Math.random() - 0.5) * 0.045;
      _v.y += 0.09 + Math.random() * 0.05;
      _v.normalize().multiplyScalar(40 + Math.random() * 5);
      ball.vel.copy(_v);
      ball.age = 0;
      ball.fromPlayer = fromPlayer;
      ball.damage = fromPlayer ? PLAYER_BALL_DMG : ENEMY_BALL_DMG;
      ball.ricochets = 0;

      this.spawnParticle("flash", muzzlesPos[i], 0.18, 1.6, 0);
      _v.set((Math.random() - 0.5) * 0.6, 1.1, (Math.random() - 0.5) * 0.6);
      this.spawnParticle("smoke", muzzlesPos[i], 0.9, 1.1, 1.6, _v);
    }
    shooter.markFired(side);
  }

  _getFreeBall() {
    for (let i = 0; i < this.maxBalls; i++) {
      if (!this.balls[i].active) return this.balls[i];
    }
    return null;
  }

  spawnParticle(type, pos, life, size, grow, vel = null) {
    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.particles[i];
      if (!p.active) {
        p.active = true;
        p.type = type;
        p.pos.copy(pos);
        p.vel.copy(vel || ZERO_VEC);
        p.age = 0;
        p.life = life;
        p.size = size;
        p.grow = grow;
        p.fade = true;
        return p;
      }
    }
    return null;
  }

  /** 受损船体持续冒烟（main 按耐久比例调用） */
  emitDamageSmoke(ship, intensity) {
    if (!intensity || Math.random() > 0.35) return;
    _v.set(ship.position.x, ship.position.y + 2.4, ship.position.z);
    const p = this.spawnParticle("smoke", _v, 1.4 + Math.random(), 0.9, 2.2);
    if (p) p.vel.set((Math.random() - 0.5) * 0.5, 1.6 + Math.random(), (Math.random() - 0.5) * 0.5);
  }

  /** 固定步长：推进炮弹、做命中、更新粒子并同步实例矩阵 */
  update(dt, playerShip, enemyManager, env, camera = null) {
    this.events.splash = 0;
    this.events.playerHit = 0;
    this.events.enemyHit = 0;
    this.events.enemySunk = 0;
    this.events.playerSunk = false;

    for (let i = 0; i < this.maxBalls; i++) {
      const b = this.balls[i];
      if (!b.active) continue;
      b.age += dt;

      // 重力 + 简化空气阻力积分
      b.vel.y -= GRAVITY * dt;
      b.vel.multiplyScalar(Math.max(0, 1 - AIR_DRAG * dt));
      b.pos.addScaledVector(b.vel, dt);

      if (b.age > 9 || b.pos.y < -30) {
        b.active = false;
        continue;
      }

      // 水面 / 陆地碰撞
      const surf = waveHeight(b.pos.x, b.pos.z, env.waveTime, env.waveWind, env.waveScale);
      const ground = this.world.heightAt(b.pos.x, b.pos.z);
      const hard = Math.max(surf, ground + 0.3);
      if (b.pos.y <= hard) {
        const speed = b.vel.length();
        const flat = Math.abs(b.vel.y) / (speed + 1e-5);
        if (b.ricochets < 1 && flat < 0.45 && speed > 24 && Math.random() < RICOCHET_CHANCE) {
          // 跳弹：弹回空中继续飞
          b.ricochets++;
          b.pos.y = hard + 0.25;
          b.vel.y = Math.abs(b.vel.y) * 0.55 + 3.2;
          b.vel.x *= 0.82;
          b.vel.z *= 0.82;
          this._splash(b.pos, 0.5);
        } else {
          this._splash(b.pos, 1);
          b.active = false;
          continue;
        }
      }

      // 球体 / 椭圆体命中判定
      if (b.fromPlayer) {
        for (const enemy of enemyManager.enemies) {
          if (enemy.ship.sunk) continue;
          if (this._hitsShip(b, enemy.ship, 2.0, 4.2)) {
            enemy.ship.damage(b.damage);
            enemyManager.discover(enemy);
            this.events.enemyHit++;
            this._hitEffect(b.pos);
            if (enemy.ship.sunk) this.events.enemySunk++;
            if (camera) camera.addShake(0.35);
            b.active = false;
            break;
          }
        }
      } else if (!playerShip.sunk && this._hitsShip(b, playerShip, 2.2, 4.4)) {
        playerShip.damage(b.damage);
        this.events.playerHit++;
        this._hitEffect(b.pos);
        if (camera) camera.addShake(0.7);
        if (playerShip.sunk) this.events.playerSunk = true;
        b.active = false;
      }
    }

    // 粒子推进
    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        continue;
      }
      p.vel.y -= (p.type === "smoke" ? -0.4 : 4.5) * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - 0.6 * dt));
      p.pos.addScaledVector(p.vel, dt);
    }

    this._syncInstances();
  }

  /** 俯视椭圆 + 高度区间命中 */
  _hitsShip(ball, ship, radius, halfLen) {
    const dx = ball.pos.x - ship.position.x;
    const dz = ball.pos.z - ship.position.z;
    const fwdX = Math.sin(ship.heading);
    const fwdZ = Math.cos(ship.heading);
    const along = dx * fwdX + dz * fwdZ;
    const across = dx * fwdZ - dz * fwdX;
    if (Math.abs(along) > halfLen || Math.abs(across) > radius) return false;
    if (ball.pos.y < ship.position.y - 1.2 || ball.pos.y > ship.position.y + 4.2) return false;
    return true;
  }

  _splash(pos, scale) {
    this.events.splash++;
    const n = scale > 0.8 ? 5 : 2;
    for (let k = 0; k < n; k++) {
      _v.set(pos.x + (Math.random() - 0.5) * 0.8, pos.y, pos.z + (Math.random() - 0.5) * 0.8);
      const p = this.spawnParticle("foam", _v, 0.7 + Math.random() * 0.3, 0.8 * scale, 1.4);
      if (p) p.vel.set((Math.random() - 0.5) * 2, 5 + Math.random() * 4, (Math.random() - 0.5) * 2);
    }
    for (let k = 0; k < 3; k++) {
      _v.set(pos.x, pos.y + 0.15, pos.z);
      this.spawnParticle("foam", _v, 1.0, 1.1 * scale, 3.2);
    }
  }

  _hitEffect(pos) {
    this.spawnParticle("flash", pos, 0.22, 2.2, 0.5);
    for (let k = 0; k < 6; k++) {
      _v.set(pos.x, pos.y + 0.6, pos.z);
      const p = this.spawnParticle("smoke", _v, 1.2 + Math.random() * 0.8, 0.9, 2.0);
      if (p) p.vel.set((Math.random() - 0.5) * 2.5, 2.2 + Math.random() * 2, (Math.random() - 0.5) * 2.5);
    }
  }

  /** 把活动炮弹 / 粒子写入 InstancedMesh（无逐帧新对象） */
  _syncInstances() {
    let bi = 0;
    for (let i = 0; i < this.maxBalls; i++) {
      const b = this.balls[i];
      if (!b.active) continue;
      this._q.identity();
      this._s.setScalar(1);
      this._m.compose(b.pos, this._q, this._s);
      this.ballMesh.setMatrixAt(bi++, this._m);
    }
    this.ballMesh.count = bi;
    this.ballMesh.instanceMatrix.needsUpdate = true;

    const counts = { foam: 0, smoke: 0, flash: 0 };
    const fadeColor = new THREE.Color();
    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      const t = p.age / p.life;
      // 生命最后 25% 缩小，减少突然消失
      const shrink = t > 0.75 ? Math.max(0.01, 1 - (t - 0.75) * 4) : 1;
      const scale = p.size * (1 + p.grow * t) * shrink;
      // 淡出
      this._q.identity();
      this._s.set(scale, scale, scale);
      this._m.compose(p.pos, this._q, this._s);
      const mesh = this.particleMeshes[p.type];
      mesh.setMatrixAt(counts[p.type]++, this._m);
      // 临近消失压暗颜色，进一步减弱“跳变”
      fadeColor.setScalar(0.35 + 0.65 * shrink);
      mesh.setColorAt(counts[p.type] - 1, fadeColor);
    }
    for (const key of Object.keys(this.particleMeshes)) {
      const mesh = this.particleMeshes[key];
      mesh.count = counts[key];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.material.opacity = 1;
    }
  }

  dispose() {
    this.scene.remove(this.ballMesh);
    this.ballMesh.geometry.dispose();
    this.ballMesh.material.dispose();
    for (const key of Object.keys(this.particleMeshes)) {
      const mesh = this.particleMeshes[key];
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
