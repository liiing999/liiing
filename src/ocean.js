// ============================================================
// ocean.js —— 跟随玩家的大平面海面
//  - 顶点着色器：多方向 Gerstner 波（参数随天气风力联动）
//  - 片元着色器：深浅水色过渡、近岸泡沫、波浪法线光照、距离雾
//  - 烘焙一张全世界海床高度纹理（R 通道，NearestFilter 像素风）
// CPU 侧 gerstnerWave* 与 GPU 使用完全相同的波参数，供船体浮力采样。
// ============================================================
import * as THREE from "three";
import { WATER_LEVEL, WORLD_W } from "./world.js";

const OCEAN_SIZE = 720;   // 海面平面世界尺寸（跟随玩家，始终覆盖视距）

const DEPTH_TEX_SIZE = 160;

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uWind;
  uniform float uWaveScale;
  varying vec3 vWorldPos;
  varying vec3 vWaveNormal;

  vec3 gerstner(vec2 dir, float wavelength, float steepness, float speed,
                float amp, vec2 p, float t, inout vec3 n) {
    float k = 6.2831853 / wavelength;
    float c = sqrt(9.8 / k);
    float f = k * (dot(dir, p) - c * speed * t);
    float a = amp * uWind * uWaveScale;
    float cf = cos(f);
    float sf = sin(f);
    n.xz -= dir * (steepness * a * k * cf);
    n.y  -= steepness * a * k * sf;
    return vec3(dir.x * steepness * a * cf, a * sf, dir.y * steepness * a * cf);
  }

  void main() {
    vec4 wp0 = modelMatrix * vec4(position, 1.0);
    vec2 p = wp0.xz;
    vec3 disp = vec3(0.0);
    vec3 n = vec3(0.0, 1.0, 0.0);

    disp += gerstner(vec2( 1.0, 0.06), 34.0, 0.42, 1.0, 0.62, p, uTime, n);
    disp += gerstner(vec2( 0.32, 0.95), 21.0, 0.50, 1.32, 0.34, p, uTime, n);
    disp += gerstner(vec2(-0.71, 0.70), 12.5, 0.55, 1.7, 0.18, p, uTime, n);
    disp += gerstner(vec2( 0.73, 0.68), 7.4, 0.60, 2.1, 0.09, p, uTime, n);

    wp0.xyz += disp;
    vWorldPos = wp0.xyz;
    vWaveNormal = normalize(n);
    gl_Position = projectionMatrix * viewMatrix * wp0;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uDepthMap;
  uniform vec2 uWorldMin;
  uniform float uWorldSize;
  uniform vec3 uSunDir;
  uniform vec3 uShallowColor;
  uniform vec3 uDeepColor;
  uniform vec3 uSkyColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uTime;
  uniform float uWind;
  varying vec3 vWorldPos;
  varying vec3 vWaveNormal;

  void main() {
    // Sample baked seabed height (R channel, NearestFilter)
    vec2 uv = clamp((vWorldPos.xz - uWorldMin) / uWorldSize, vec2(0.0), vec2(1.0));
    float groundH = texture2D(uDepthMap, uv).r;
    float waterH = vWorldPos.y;
    float depth = waterH - groundH;

    // Shallow -> deep water color
    float deepT = smoothstep(0.6, 10.0, depth);
    vec3 col = mix(uShallowColor, uDeepColor, deepT);

    // Wave normal lighting (half-lambert + specular sun glint)
    vec3 n = normalize(vWaveNormal);
    float diff = clamp(dot(n, normalize(uSunDir)) * 0.5 + 0.5, 0.0, 1.0);
    col *= 0.55 + 0.5 * diff;
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 halfV = normalize(normalize(uSunDir) + viewDir);
    float spec = pow(clamp(dot(n, halfV), 0.0, 1.0), 42.0) * 0.9;
    col += vec3(1.0, 0.95, 0.8) * spec * clamp(uSunDir.y + 0.1, 0.0, 1.0);

    // Shore foam on very shallow water and on wave crests
    float shore = 1.0 - smoothstep(0.15, 1.6, depth);
    float crest = pow(max(0.0, sin((vWorldPos.x * 0.55 + vWorldPos.z * 0.38) + uTime * 2.0)), 8.0);
    float foam = clamp(shore * (0.55 + crest * 0.7 * uWind), 0.0, 1.0);
    col = mix(col, vec3(0.93, 0.97, 0.98), foam);

    // More transparent over shallows so the seabed is visible
    float alpha = mix(0.62, 0.94, deepT);

    // Distance fog blends distant islands and sea into the horizon
    float dist = length(cameraPosition - vWorldPos);
    float fogF = smoothstep(uFogNear, uFogFar, dist);
    col = mix(col, uFogColor, fogF);
    alpha = mix(alpha, 1.0, fogF);

    gl_FragColor = vec4(col, alpha);
  }
`;

export class Ocean {
  /**
   * @param {World} world
   * @param {{oceanSeg:number, waveScale:number}} quality
   */
  constructor(world, quality) {
    this.world = world;
    this.time = 0;
    this.wind = 1;
    this.waveScale = quality.waveScale;

    // 烘焙海床高度纹理（R 通道 = 高度，FloatType，NearestFilter）
    this.depthTexture = this._buildDepthTexture();

    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: 1 },
      uWaveScale: { value: this.waveScale },
      uDepthMap: { value: this.depthTexture },
      uWorldMin: { value: new THREE.Vector2(-WORLD_W / 2, -WORLD_W / 2) },
      uWorldSize: { value: WORLD_W },
      uSunDir: { value: new THREE.Vector3(0.4, 1, 0.3) },
      uShallowColor: { value: new THREE.Color(0x35a08a) },
      uDeepColor: { value: new THREE.Color(0x0e3d63) },
      uSkyColor: { value: new THREE.Color(0x8ec7e8) },
      uFogColor: { value: new THREE.Color(0xa8c8dc) },
      uFogNear: { value: 120 },
      uFogFar: { value: 420 },
    };

    const geo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, quality.oceanSeg, quality.oceanSeg);
    geo.rotateX(-Math.PI / 2);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false; // 跟随玩家移动，直接禁用包围球剔除
  }

  /** 生成全世界海床高度图：R = ground height（米） */
  _buildDepthTexture() {
    const data = new Float32Array(DEPTH_TEX_SIZE * DEPTH_TEX_SIZE);
    const half = WORLD_W / 2;
    let i = 0;
    for (let ty = 0; ty < DEPTH_TEX_SIZE; ty++) {
      const z = -half + (ty / (DEPTH_TEX_SIZE - 1)) * WORLD_W;
      for (let tx = 0; tx < DEPTH_TEX_SIZE; tx++) {
        const x = -half + (tx / (DEPTH_TEX_SIZE - 1)) * WORLD_W;
        data[i++] = this.world.heightAt(x, z);
      }
    }
    const tex = new THREE.DataTexture(data, DEPTH_TEX_SIZE, DEPTH_TEX_SIZE, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  setQuality(waveScale) {
    this.waveScale = waveScale;
    this.uniforms.uWaveScale.value = waveScale;
  }

  setWeather(weather) {
    this.wind = weather.windWave;
    this.uniforms.uWind.value = weather.windWave;
    this.uniforms.uShallowColor.value.setHex(weather.shallowColor);
    this.uniforms.uDeepColor.value.setHex(weather.deepColor);
  }

  setFog(color, near, far) {
    this.uniforms.uFogColor.value.copy(color);
    this.uniforms.uFogNear.value = near;
    this.uniforms.uFogFar.value = far;
  }

  setSun(dir, skyColor) {
    this.uniforms.uSunDir.value.copy(dir);
    this.uniforms.uSkyColor.value.copy(skyColor);
  }

  /** 海面跟随玩家（对齐到 8m 网格，避免波浪滑动穿帮） */
  update(dt, px, pz) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    const g = 8;
    this.mesh.position.set(Math.round(px / g) * g, WATER_LEVEL, Math.round(pz / g) * g);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.depthTexture.dispose();
  }
}

// ============================================================
// CPU 波浪采样（与顶点着色器同一组参数）——用于船浮力 / 炮弹入水
// ============================================================

/** 单组 Gerstner 波：返回位移并累加法线 */
function gerstnerWave(dir, wavelength, amp, speed, p, t, outDisp, outN) {
  const k = (Math.PI * 2) / wavelength;
  const c = Math.sqrt(9.8 / k);
  const f = k * (dir.x * p.x + dir.y * p.y - c * speed * t);
  const a = amp;
  outDisp.x += dir.x * a * Math.cos(f);
  outDisp.y += a * Math.sin(f);
  outDisp.z += dir.y * a * Math.cos(f);
  outN.x -= dir.x * (a * k * Math.cos(f));
  outN.z -= dir.y * (a * k * Math.cos(f));
  outN.y -= a * k * Math.sin(f);
}

/**
 * 采样某世界点的波高（相对海平面）
 * @param wind 天气风力系数（0.5~2.2）
 * @param scale 画质波高倍数
 */
const _dirScratch = new THREE.Vector2();
const _pScratch = new THREE.Vector2();
export function waveHeight(x, z, time, wind = 1, scale = 1, out = null) {
  const p = _pScratch.set(x, z);
  let y = 0;
  const disp = { x: 0, y: 0, z: 0 };
  const n = { x: 0, y: 1.0, z: 0 };
  const dirs = [
    [1.0, 0.06, 34, 0.62, 1.0, 0.42],
    [0.32, 0.95, 21, 0.34, 1.32, 0.5],
    [-0.71, 0.70, 12.5, 0.18, 1.7, 0.55],
    [0.73, 0.68, 7.4, 0.09, 2.1, 0.6],
  ];
  for (const d of dirs) {
    _dirScratch.set(d[0], d[1]).normalize();
    const amp = d[3] * wind * scale;
    gerstnerWave(_dirScratch, d[2], amp * d[5], d[4], p, time, disp, n);
  }
  y = WATER_LEVEL + disp.y;
  if (out) {
    out.y = y;
    const nl = Math.hypot(n.x, n.y, n.z) || 1;
    out.nx = n.x / nl;
    out.ny = n.y / nl;
    out.nz = n.z / nl;
    out.dx = disp.x;
    out.dz = disp.z;
  }
  return y;
}
