// ocean.js —— 跟随玩家的大海面：顶点着色器叠加 4 组 Gerstner 波浪，
// 包含深浅水颜色过渡、岸边泡沫与波峰白沫，波浪法线参与光照，参数与天气风力联动。
// CPU 端用与着色器完全一致的公式采样波高 / 法线，供船体浮力与姿态使用。

import * as THREE from 'three';
import { WORLD_HALF, WORLD_SIZE } from './world.js';

const WAVE_COUNT = 4;
const MAP_RES = 256; // 海底高度图分辨率

// 四组波相对风向的方向偏角与基础波长 / 振幅比例
const DIR_OFFSETS = [0.0, 0.55, -0.45, 1.15];
const WAVE_LENGTHS = [26, 14, 8.5, 5.2];
const BASE_AMPS = [0.9, 0.5, 0.3, 0.18];

/**
 * 根据风向角度生成四组波传播方向
 * @param {number} windAngle 风的来向角（弧度）
 * @param {Array<{x:number,z:number}>} out
 */
function buildDirections(windAngle, out) {
  const base = windAngle + Math.PI; // 波沿风的去向传播
  for (let i = 0; i < WAVE_COUNT; i++) {
    const a = base + DIR_OFFSETS[i];
    out[i].x = Math.sin(a);
    out[i].z = Math.cos(a);
  }
}

/**
 * 海面。
 */
export class Ocean {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./world.js').World} world 用于读取海底高度
   */
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;

    this.windAngle = 0;
    this.windStrength = 0.6;
    this.waveScale = 0.6;
    this.directions = Array.from({ length: WAVE_COUNT }, () => ({ x: 0, z: 1 }));
    this.amplitudes = new Float32Array(WAVE_COUNT);
    this.lengths = WAVE_LENGTHS.slice();
    this.speeds = new Float32Array(WAVE_COUNT);
    this.phases = new Float32Array([0, 1.3, 2.7, 4.1]);
    buildDirections(this.windAngle, this.directions);

    this.heightTexture = this._buildHeightTexture();
    this._buildMesh();
    // uniform 对象在 _buildMesh 中创建，之后再同步一次波浪参数
    this._updateWaveParams();
  }

  /** 预渲染世界范围的海底高度到浮点 DataTexture，供着色器判深浅水 / 泡沫。 */
  _buildHeightTexture() {
    const data = new Float32Array(MAP_RES * MAP_RES);
    for (let iz = 0; iz < MAP_RES; iz++) {
      for (let ix = 0; ix < MAP_RES; ix++) {
        const wx = -WORLD_HALF + (ix / (MAP_RES - 1)) * WORLD_SIZE;
        const wz = -WORLD_HALF + (iz / (MAP_RES - 1)) * WORLD_SIZE;
        data[iz * MAP_RES + ix] = this.world.getHeight(wx, wz);
      }
    }
    const texture = new THREE.DataTexture(data, MAP_RES, MAP_RES, THREE.RedFormat, THREE.FloatType);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }

  /** 构建大平面网格与自定义海面着色器。 */
  _buildMesh() {
    const geometry = new THREE.PlaneGeometry(1400, 1400, 96, 96);
    geometry.rotateX(-Math.PI / 2);

    this.gpuUniforms = {
      uTime: { value: 0 },
      uHeightMap: { value: this.heightTexture },
      uMapMin: { value: -WORLD_HALF },
      uMapSize: { value: WORLD_SIZE },
      uDirs: { value: new Float32Array(WAVE_COUNT * 2) },
      uAmps: { value: new Float32Array(WAVE_COUNT) },
      uFreqs: { value: new Float32Array(WAVE_COUNT) },
      uSpeeds: { value: new Float32Array(WAVE_COUNT) },
      uPhases: { value: new Float32Array(WAVE_COUNT) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.8) },
      uDeepColor: { value: new THREE.Color(0.04, 0.18, 0.3) },
      uShallowColor: { value: new THREE.Color(0.18, 0.55, 0.62) },
      uSkyColor: { value: new THREE.Color(0.55, 0.75, 0.9) },
      uFoamColor: { value: new THREE.Color(0.9, 0.96, 1.0) },
      uWeatherTint: { value: new THREE.Color(1, 1, 1) },
      // 雾相关 uniform：#include <fog_*> 着色器块需要它们存在
      fogColor: { value: new THREE.Color(0.7, 0.8, 0.9) },
      fogNear: { value: 120 },
      fogFar: { value: 520 }
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.gpuUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      vertexShader: [
        'uniform float uTime;',
        'uniform sampler2D uHeightMap;',
        'uniform float uMapMin;',
        'uniform float uMapSize;',
        'uniform vec2 uDirs[' + WAVE_COUNT + '];',
        'uniform float uAmps[' + WAVE_COUNT + '];',
        'uniform float uFreqs[' + WAVE_COUNT + '];',
        'uniform float uSpeeds[' + WAVE_COUNT + '];',
        'uniform float uPhases[' + WAVE_COUNT + '];',
        '#include <fog_pars_vertex>',
        'varying vec3 vWorldPos;',
        'varying vec3 vNormal;',
        'varying float vTerrainH;',
        'varying float vWaveCrest;',
        'void main() {',
        '  vec3 pos = position;',
        '  vec3 world0 = pos + (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;',
        '  vec2 uvH = clamp((world0.xz - uMapMin) / uMapSize, vec2(0.0), vec2(1.0));',
        '  bool insideMap = world0.x >= uMapMin && world0.x <= uMapMin + uMapSize',
        '                && world0.z >= uMapMin && world0.z <= uMapMin + uMapSize;',
        '  float terrainH = texture2D(uHeightMap, uvH).r;',
        '  if (!insideMap) terrainH = -20.0;',
        '  vTerrainH = terrainH;',
        '  float waveH = 0.0; vec2 disp = vec2(0.0); vec2 grad = vec2(0.0); float crest = 0.0;',
        '  for (int i = 0; i < ' + WAVE_COUNT + '; i++) {',
        '    vec2 dir = uDirs[i];',
        '    float amp = uAmps[i];',
        '    float freq = uFreqs[i];',
        '    float phase = dot(dir, world0.xz) * freq + uTime * uSpeeds[i] + uPhases[i];',
        '    float s = sin(phase); float c = cos(phase);',
        '    float shoreFade = smoothstep(-1.5, 1.0, terrainH);',
        '    amp *= mix(1.0, 0.12, shoreFade);',
        '    waveH += amp * s;',
        '    disp += 0.65 * amp * dir * c;',
        '    grad += dir * (amp * freq * c);',
        '    crest += amp * s;',
        '  }',
        '  pos.x += disp.x; pos.z += disp.y; pos.y += waveH;',
        '  vWaveCrest = crest;',
        '  vNormal = normalize(vec3(-grad.x, 1.0, -grad.y));',
        '  vec4 wp = modelMatrix * vec4(pos, 1.0);',
        '  vWorldPos = wp.xyz;',
        '  vec4 mvPosition = viewMatrix * wp;',
        '  gl_Position = projectionMatrix * mvPosition;',
        '#include <fog_vertex>',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uSunDir;',
        'uniform vec3 uSunColor;',
        'uniform vec3 uDeepColor;',
        'uniform vec3 uShallowColor;',
        'uniform vec3 uSkyColor;',
        'uniform vec3 uFoamColor;',
        'uniform vec3 uWeatherTint;',
        'uniform float uTime;',
        'varying vec3 vWorldPos;',
        'varying vec3 vNormal;',
        'varying float vTerrainH;',
        'varying float vWaveCrest;',
        '#include <fog_pars_fragment>',
        'void main() {',
        '  vec3 N = normalize(vNormal);',
        '  vec3 V = normalize(cameraPosition - vWorldPos);',
        '  float depth = vWorldPos.y - vTerrainH;',
        '  float shallowMix = 1.0 - smoothstep(1.0, 13.0, depth);',
        '  vec3 color = mix(uDeepColor, uShallowColor, shallowMix);',
        '  vec3 L = normalize(uSunDir);',
        '  float diff = clamp(dot(N, L), 0.0, 1.0);',
        '  color *= uWeatherTint * (0.45 + diff * uSunColor);',
        '  vec3 Hv = normalize(L + V);',
        '  float spec = pow(clamp(dot(N, Hv), 0.0, 1.0), 60.0) * 0.7;',
        '  color += uSunColor * spec;',
        '  float fresnel = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);',
        '  color = mix(color, uSkyColor * uWeatherTint, fresnel * 0.55);',
        '  float shoreFoam = smoothstep(0.6, -1.6, vTerrainH) * (1.0 - smoothstep(-1.6, -4.0, vTerrainH));',
        '  float foamNoise = 0.5 + 0.5 * sin(vWorldPos.x * 0.8 + uTime * 2.0) * sin(vWorldPos.z * 0.7 - uTime * 1.6);',
        '  float crestFoam = smoothstep(0.9, 1.8, vWaveCrest);',
        '  float foam = clamp(shoreFoam * (0.55 + foamNoise * 0.45) + crestFoam * 0.5, 0.0, 1.0);',
        '  color = mix(color, uFoamColor, foam);',
        '  gl_FragColor = vec4(color, 0.84);',
        '#include <fog_fragment>',
        '}'
      ].join('\n')
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /** 根据当前风力 / 天气更新波高、频率（同步 CPU 与 GPU）。 */
  _updateWaveParams() {
    buildDirections(this.windAngle, this.directions);
    for (let i = 0; i < WAVE_COUNT; i++) {
      this.amplitudes[i] = BASE_AMPS[i] * this.waveScale * (0.35 + this.windStrength);
      const freq = (Math.PI * 2) / this.lengths[i];
      this.speeds[i] = Math.sqrt(9.8 / freq) * (0.9 + this.windStrength * 0.5);
    }
    this._syncGpuUniforms();
  }

  /** 把 CPU 波浪参数拷贝到着色器 uniform 数组。 */
  _syncGpuUniforms() {
    const u = this.gpuUniforms;
    for (let i = 0; i < WAVE_COUNT; i++) {
      u.uDirs.value[i * 2] = this.directions[i].x;
      u.uDirs.value[i * 2 + 1] = this.directions[i].z;
      u.uAmps.value[i] = this.amplitudes[i];
      u.uFreqs.value[i] = (Math.PI * 2) / this.lengths[i];
      u.uSpeeds.value[i] = this.speeds[i];
      u.uPhases.value[i] = this.phases[i];
    }
  }

  /**
   * 设置风向、风力与波高系数（由天气系统驱动），带平滑过渡。
   * @param {number} angle 风的来向角（弧度）
   * @param {number} strength 0..1
   * @param {number} waveScale 天气波高系数
   */
  setWind(angle, strength, waveScale) {
    let delta = angle - this.windAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.windAngle += delta * 0.05;
    this.windStrength += (strength - this.windStrength) * 0.05;
    this.waveScale += (waveScale - this.waveScale) * 0.05;
    this._updateWaveParams();
  }

  /**
   * CPU 端单波高度（含近岸衰减），供采样函数复用。
   * @param {number} x
   * @param {number} z
   * @param {number} time
   * @param {number} terrainH
   * @returns {number}
   */
  _waveAt(x, z, time, terrainH) {
    let sum = 0;
    const shoreFade = THREE.MathUtils.smoothstep(terrainH, -1.5, 1.0);
    const depthMul = 1.0 - shoreFade * 0.88;
    for (let i = 0; i < WAVE_COUNT; i++) {
      const freq = (Math.PI * 2) / this.lengths[i];
      const amp = this.amplitudes[i] * depthMul;
      const phase = this.directions[i].x * x * freq +
        this.directions[i].z * z * freq +
        time * this.speeds[i] + this.phases[i];
      sum += amp * Math.sin(phase);
    }
    return sum;
  }

  /**
   * 采样某点水面世界高度（地形 + 波），供船体浮力与弹道入水判定使用。
   * @param {number} x
   * @param {number} z
   * @param {number} time
   * @returns {number}
   */
  getHeightAt(x, z, time) {
    const terrainH = this.world.getHeight(x, z);
    // 深水区基准水面为 0；仅在近岸/陆地处让水面贴合抬升的地形，
    // 避免海面淹没沙滩（陆地附近水体被压到地表附近）。
    const base = terrainH > -0.5 ? Math.min(0, terrainH + 0.3) : 0;
    return base + this._waveAt(x, z, time, terrainH);
  }

  /**
   * 采样水面波浪法线（忽略地形，只取波梯度），用于船体横摇 / 纵摇。
   * @param {number} x
   * @param {number} z
   * @param {number} time
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3}
   */
  getNormalAt(x, z, time, out) {
    const epsilon = 1.2;
    const hC = this._waveAt(x, z, time, -10);
    const hX = this._waveAt(x + epsilon, z, time, -10);
    const hZ = this._waveAt(x, z + epsilon, time, -10);
    out.set(-(hX - hC) / epsilon, 1, -(hZ - hC) / epsilon).normalize();
    return out;
  }

  /** 让海面中心跟随玩家，保证船体始终在网格范围内。 */
  setCenter(x, z) {
    this.mesh.position.set(x, 0, z);
  }

  /**
   * 每帧更新时间 uniform 与光照参数。
   * @param {number} time
   * @param {THREE.Vector3} sunDir
   * @param {THREE.Color} sunColor
   * @param {THREE.Color} skyColor
   * @param {THREE.Color} fogColor
   * @param {{near:number, far:number}} fogRange
   * @param {THREE.Color} weatherTint
   */
  update(time, sunDir, sunColor, skyColor, fogColor, fogRange, weatherTint) {
    this.gpuUniforms.uTime.value = time;
    this.gpuUniforms.uSunDir.value.copy(sunDir);
    this.gpuUniforms.uSunColor.value.copy(sunColor);
    this.gpuUniforms.uSkyColor.value.copy(skyColor);
    this.gpuUniforms.uWeatherTint.value.copy(weatherTint);
    this.gpuUniforms.fogColor.value.copy(fogColor);
    this.gpuUniforms.fogNear.value = fogRange.near;
    this.gpuUniforms.fogFar.value = fogRange.far;
  }

  /** 释放资源（重置世界）。 */
  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.heightTexture.dispose();
  }
}
