// camera.js —— 第三人称阻尼跟随相机：鼠标环绕、滚轮缩放、防穿地形与水面；
// V 切换船长第一人称；按住 Z 进入望远镜（收窄 FOV）。

import * as THREE from 'three';

const DEG = Math.PI / 180;

export class CameraRig {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('./world.js').World} world
   * @param {import('./ocean.js').Ocean} ocean
   */
  constructor(camera, world, ocean) {
    this.camera = camera;
    this.world = world;
    this.ocean = ocean;

    this.mode = 'third'; // 'third' | 'first'
    this.spyglass = false;

    // 环绕角与距离
    this.yaw = 0;
    this.pitch = 0.32;
    this.distance = 15;
    this.minDistance = 6;
    this.maxDistance = 40;

    // 灵敏度（由设置写入）
    this.sensitivity = 1.0;

    // 阻尼后的实际值
    this._camPos = new THREE.Vector3(0, 8, -12);
    this._lookTarget = new THREE.Vector3();
    this._currentFov = 60;

    this._desired = new THREE.Vector3();
    this._target = new THREE.Vector3();
  }

  /** 切换第一 / 第三人称。 */
  toggleMode() {
    this.mode = this.mode === 'third' ? 'first' : 'third';
  }

  /** 设置望远镜状态。 */
  setSpyglass(on) {
    this.spyglass = on;
  }

  /**
   * 鼠标移动改变环绕角
   * @param {number} dx
   * @param {number} dy
   */
  addLook(dx, dy) {
    const s = 0.0026 * this.sensitivity;
    this.yaw -= dx * s;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * s, -0.2, 1.25);
  }

  /**
   * 滚轮缩放
   * @param {number} deltaY
   */
  zoom(deltaY) {
    this.distance = THREE.MathUtils.clamp(
      this.distance + Math.sign(deltaY) * 1.6,
      this.minDistance, this.maxDistance
    );
  }

  /**
   * 每帧更新相机。
   * @param {number} dt
   * @param {import('./ship.js').Ship} ship
   */
  update(dt, ship) {
    const time = this.ocean.time || 0;
    // 船的观察参考点（水面以上一点）
    this._target.copy(ship.position);
    this._target.y = this.ocean.getHeightAt(ship.position.x, ship.position.z, time) + 2.2;

    if (this.mode === 'first') {
      // 第一人称：站在船尾舵轮位置，朝向由环绕角决定
      const local = new THREE.Vector3(0, 4.2, -1.8);
      local.applyAxisAngle(new THREE.Vector3(0, 1, 0), ship.heading);
      this._desired.set(
        ship.position.x + local.x,
        this.ocean.getHeightAt(ship.position.x, ship.position.z, time) + local.y,
        ship.position.z + local.z
      );
      this._camPos.lerp(this._desired, Math.min(1, dt * 12));
      this._lookTarget.lerp(this._target, Math.min(1, dt * 12));
      this.camera.position.copy(this._camPos);
      // 第一人称视角朝向 = 船航向 + 环绕偏移
      const look = new THREE.Vector3(
        Math.sin(ship.heading + this.yaw),
        Math.sin(this.pitch - 0.2),
        Math.cos(ship.heading + this.yaw)
      );
      this.camera.lookAt(this._camPos.clone().add(look));
    } else {
      // 第三人称：球坐标绕船
      const horizontal = Math.cos(this.pitch) * this.distance;
      const offsetX = Math.sin(this.yaw) * horizontal;
      const offsetZ = Math.cos(this.yaw) * horizontal;
      const offsetY = Math.sin(this.pitch) * this.distance;
      this._desired.set(
        this._target.x + offsetX,
        this._target.y + offsetY,
        this._target.z + offsetZ
      );
      this._collide(this._desired, this._target);
      // 阻尼跟随（不硬跟随）
      const alpha = 1 - Math.pow(0.0015, dt);
      this._camPos.lerp(this._desired, alpha);
      this._lookTarget.lerp(this._target, Math.min(1, dt * 10));
      this.camera.position.copy(this._camPos);
      this.camera.lookAt(this._lookTarget);
    }

    // 望远镜收窄 FOV，平滑过渡
    const targetFov = this.spyglass ? 22 : 60;
    this._currentFov += (targetFov - this._currentFov) * Math.min(1, dt * 8);
    if (Math.abs(this.camera.fov - this._currentFov) > 0.05) {
      this.camera.fov = this._currentFov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * 相机防穿模：若相机位置被地形挡住则拉近；同时保证不进入水面以下。
   * @param {THREE.Vector3} desired
   * @param {THREE.Vector3} target
   */
  _collide(desired, target) {
    // 沿目标到相机的连线步进采样地形高度
    const steps = 8;
    let allowed = desired.distanceTo(target);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = target.x + (desired.x - target.x) * t;
      const pz = target.z + (desired.z - target.z) * t;
      const groundH = this.world.getHeight(px, pz);
      const waterH = this.ocean.getHeightAt(px, pz, this.ocean.time || 0);
      const safeY = Math.max(groundH + 2.2, waterH + 1.2);
      if (desired.y < safeY) {
        // 抬高相机
        desired.y = safeY;
      }
      // 如果该点地形本身高于相机所在高度，说明穿岛，限制距离
      if (groundH > desired.y) {
        allowed = Math.min(allowed, target.distanceTo(new THREE.Vector3(px, groundH + 2.4, pz)));
      }
    }
    // 用允许的距离重新投影
    const dir = desired.clone().sub(target);
    const total = dir.length();
    if (total > allowed) {
      dir.normalize().multiplyScalar(allowed);
      desired.copy(target).add(dir);
    }
  }
}
