// ============================================================
// camera.js —— 第三人称跟随相机（阻尼）
//  - 鼠标环绕 / 滚轮缩放 / 第一人称(V) / 望远镜(Z 按住)
//  - 相机不允许穿进岛屿或水面以下（射线 / 高度场回拉）
// ============================================================
import * as THREE from "three";

const _desired = new THREE.Vector3();
const _target = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _shipFwd = new THREE.Vector3();

export class CameraRig {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {World} world
   * @param {object} settings { sensitivity }
   */
  constructor(camera, world, settings) {
    this.camera = camera;
    this.world = world;
    this.sensitivity = settings.sensitivity || 1;

    // 环绕参数
    this.yaw = 0;            // 相对船头的偏航偏移
    this.pitch = 0.42;       // 俯视俯仰
    this.distance = 13;
    this.minDist = 6;
    this.maxDist = 34;

    this.firstPerson = false;
    this.spyglass = false;

    // 阻尼后的相机位置 / 朝向
    this.smoothed = new THREE.Vector3(0, 8, -12);
    this.lookSmoothed = new THREE.Vector3();
    this._initialized = false;

    // 镜头震动
    this.shake = 0;

    // 望远镜插值
    this.fovCurrent = 60;
    this.fovNormal = 60;
    this.fovSpy = 18;
  }

  setSensitivity(s) {
    this.sensitivity = s;
  }

  /** 鼠标移动（pointer lock 下的 movementX/Y） */
  onMouseMove(dx, dy) {
    const s = 0.0026 * this.sensitivity;
    this.yaw -= dx * s;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * s * 0.7, 0.08, 1.25);
  }

  /** 滚轮缩放 */
  onWheel(deltaY) {
    const next = this.distance + Math.sign(deltaY) * 1.4;
    this.distance = THREE.MathUtils.clamp(next, this.minDist, this.maxDist);
  }

  toggleFirstPerson() {
    this.firstPerson = !this.firstPerson;
    return this.firstPerson;
  }

  setSpyglass(on) {
    this.spyglass = on;
  }

  addShake(amount) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  /**
   * 每帧更新
   * @param {Ship} ship
   * @param {number} dt
   * @param {Ocean} ocean 用于取波高避免入水（这里直接用世界高度 + 波高函数）
   * @param {number} waveTime
   * @param {number} waveWind
   * @param {number} waveScale
   */
  update(ship, dt, waveTime, waveWind, waveScale, waveHeightFn) {
    // 船前向
    _shipFwd.set(Math.sin(ship.heading), 0, Math.cos(ship.heading));

    // ---------------- 第一人称（船长视角） ----------------
    if (this.firstPerson) {
      ship.getHelmPosition(_target);
      if (!this._initialized) {
        this.smoothed.copy(_target);
        this.lookSmoothed.copy(_target).addScaledVector(_shipFwd.set(Math.sin(ship.heading), 0, Math.cos(ship.heading)), 8);
        this._initialized = true;
      }
      this.smoothed.lerp(_target, 1 - Math.exp(-18 * dt));
      // 视角直接看向船头方向（鼠标 yaw/pitch 作为头部微调）
      const lookYaw = ship.heading + this.yaw * 0.6;
      const lookPitch = -this.pitch + 0.12;
      _desired
        .set(Math.sin(lookYaw) * Math.cos(lookPitch), Math.sin(lookPitch), Math.cos(lookYaw) * Math.cos(lookPitch))
        .add(this.smoothed);
      this.lookSmoothed.lerp(_desired, 1 - Math.exp(-20 * dt));
      this.camera.position.copy(this.smoothed);
      this.camera.lookAt(this.lookSmoothed);
    } else {
      // ---------------- 第三人称环绕跟随（带阻尼） ----------------
      const angleYaw = ship.heading + this.yaw;
      const cp = Math.cos(this.pitch);
      // 期望相机位置：船后方上方
      _camPos.set(
        ship.position.x - Math.sin(angleYaw) * cp * this.distance,
        ship.position.y + Math.sin(this.pitch) * this.distance + 1.6,
        ship.position.z - Math.cos(angleYaw) * cp * this.distance
      );

      // 防穿墙：沿“目标→相机”方向检测地表，相机必须高于地表+余量
      this._pullOutOfGround(_camPos, ship, waveTime, waveWind, waveScale, waveHeightFn);

      if (!this._initialized) {
        this.smoothed.copy(_camPos);
        this.lookSmoothed.copy(ship.position).setY(ship.position.y + 1.8);
        this._initialized = true;
      }
      // 位置阻尼（不做硬跟随）
      this.smoothed.lerp(_camPos, 1 - Math.exp(-7 * dt));
      // 看向船稍高位置
      _target.copy(ship.position);
      _target.y += 1.8;
      this.lookSmoothed.lerp(_target, 1 - Math.exp(-10 * dt));

      // 镜头震动
      if (this.shake > 0.001) {
        this.smoothed.x += (Math.random() - 0.5) * this.shake * 0.35;
        this.smoothed.y += (Math.random() - 0.5) * this.shake * 0.35;
        this.shake *= Math.exp(-6 * dt);
      }

      this.camera.position.copy(this.smoothed);
      this.camera.lookAt(this.lookSmoothed);
    }

    // ---------------- FOV：望远镜收窄 ----------------
    const targetFov = this.spyglass
      ? this.fovSpy
      : this.fovNormal * (this.firstPerson ? 1 : 1);
    this.fovCurrent += (targetFov - this.fovCurrent) * (1 - Math.exp(-10 * dt));
    if (Math.abs(this.camera.fov - this.fovCurrent) > 0.01) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * 相机防穿：在目标点与相机之间采样高度场，
   * 如果相机位置低于“地表/波浪 + 安全高度”，则沿连线回拉。
   */
  _pullOutOfGround(camPos, ship, waveTime, waveWind, waveScale, waveHeightFn) {
    const minClearance = 1.4;
    // 相机自身所在点的地表 / 水面
    const ground = this.world.heightAt(camPos.x, camPos.z);
    const water = waveHeightFn(camPos.x, camPos.z, waveTime, waveWind, waveScale);
    const floor = Math.max(ground + minClearance + 0.5, water + minClearance);
    if (camPos.y < floor) camPos.y = floor;

    // 从船到相机之间若被岛屿遮挡，逐步把相机拉到遮挡点前
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = THREE.MathUtils.lerp(ship.position.x, camPos.x, t);
      const pz = THREE.MathUtils.lerp(ship.position.z, camPos.z, t);
      const gy = this.world.heightAt(px, pz);
      const wy = waveHeightFn(px, pz, waveTime, waveWind, waveScale);
      const safe = Math.max(gy + 1.0, wy + 0.8);
      // 该采样点对应的相机视线高度
      const eyeY = THREE.MathUtils.lerp(ship.position.y + 1.8, camPos.y, t);
      if (safe > eyeY) {
        // 遮挡：把相机放到前一安全采样点附近
        const tPrev = (i - 1) / steps;
        camPos.x = THREE.MathUtils.lerp(ship.position.x, camPos.x, Math.max(0.06, tPrev));
        camPos.z = THREE.MathUtils.lerp(ship.position.z, camPos.z, Math.max(0.06, tPrev));
        camPos.y = Math.max(safe + 0.6, THREE.MathUtils.lerp(ship.position.y + 2.2, camPos.y, Math.max(0.06, tPrev)));
        break;
      }
    }
  }
}
