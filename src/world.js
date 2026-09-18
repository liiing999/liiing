// ============================================================
// world.js —— 程序化群岛世界
//  - 多层自研噪声（见 noise.js）生成高度场
//  - 有限世界 12×12 区块，每块 64×64 世界单位
//  - 两级 LOD，区块动态生成 / 卸载，边缘裙边消除裂缝
//  - 沙滩 / 草地 / 岩壁 / 内陆山丘 四大地貌（顶点色）
//  - 棕榈 / 松树 / 礁石 InstancedMesh
// ============================================================
import * as THREE from "three";
import { PerlinNoise2D, fbm2, ridge2, mulberry32 } from "./noise.js";

// ---------------- 全局常量 ----------------
export const CHUNK_SIZE = 64;          // 一块的世界尺寸
export const CHUNKS_X = 12;            // 世界横向块数
export const CHUNKS_Z = 12;            // 世界纵向块数
export const WORLD_W = CHUNK_SIZE * CHUNKS_X;
export const WORLD_HALF = WORLD_W / 2;
export const WATER_LEVEL = 0;          // 海平面高度
export const SKIRT_DEPTH = 22;         // 区块边缘裙边深度（低于最深海床，防裂缝 / 空洞）

const SEA_FLOOR = -14;                 // 深海床基准

// 地形配色（低多边形卡通）
const C_UNDERWATER = new THREE.Color(0x6d8f7a); // 水下浅滩底
const C_DEEPBOTTOM = new THREE.Color(0x27494a); // 较深海底
const C_SAND = new THREE.Color(0xe3d29a);
const C_SAND_DRY = new THREE.Color(0xd8c17c);
const C_GRASS = new THREE.Color(0x5f9e4a);
const C_GRASS_DARK = new THREE.Color(0x3f7d3a);
const C_HILL = new THREE.Color(0x8a7a4e);      // 内陆山丘（草甸与岩土过渡）
const C_ROCK = new THREE.Color(0x7d7a74);
const C_ROCK_DARK = new THREE.Color(0x5b5852);

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// 共享临时对象，避免热路径 GC
const _c = new THREE.Color();

// ============================================================
// World：岛屿布局 + 全局高度场查询
// ============================================================
export class World {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    // 多个独立噪声层：海底起伏 / 岛屿粗轮廓 / 地表细节 / 山脊
    this.floorNoise = new PerlinNoise2D(this.seed ^ 0x11111111);
    this.coastNoise = new PerlinNoise2D(this.seed ^ 0x22222222);
    this.detailNoise = new PerlinNoise2D(this.seed ^ 0x33333333);
    this.ridgeNoise = new PerlinNoise2D(this.seed ^ 0x44444444);

    this.islands = [];
    this._generateIslandLayout();

    // 共用材质 / 几何体（在 ChunkManager 中初始化）
    this.terrainMaterial = null;
    this.palmGeometry = null;
    this.pineGeometry = null;
    this.rockGeometry = null;
  }

  /** 确定性地布置岛屿（尽量不重叠） */
  _generateIslandLayout() {
    const count = 17 + Math.floor(this.rng() * 4); // 17~20 座岛
    let attempts = 0;
    while (this.islands.length < count && attempts < 400) {
      attempts++;
      // 与世界边界保持距离
      const margin = 70;
      const x = (this.rng() * 2 - 1) * (WORLD_HALF - margin);
      const z = (this.rng() * 2 - 1) * (WORLD_HALF - margin);
      const rx = 26 + this.rng() * 30;
      const rz = rx * (0.75 + this.rng() * 0.5);
      const maxH = 13 + this.rng() * 13;
      // 岛屿间留出可航行水道
      let ok = true;
      for (const isl of this.islands) {
        const d = Math.hypot(x - isl.cx, z - isl.cz);
        if (d < (Math.max(rx, isl.rx) + Math.max(rz, isl.rz)) * 0.55 + 46) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      this.islands.push({
        cx: x,
        cz: z,
        rx,
        rz,
        maxH,
        rot: this.rng() * Math.PI,
        off: this.rng() * 1000,
      });
    }
  }

  /**
   * 全局高度场：岛屿最高处 + 深海床
   * h < 0 为水面以下；h ≈ 0 为海岸线
   */
  heightAt(x, z) {
    // 深海床：缓慢起伏
    let h = SEA_FLOOR + 1.5 + fbm2(this.floorNoise, x * 0.012 + 11.2, z * 0.012 - 4.7, 3) * 4.2;

    for (let i = 0; i < this.islands.length; i++) {
      const isl = this.islands[i];
      const dx = x - isl.cx;
      const dz = z - isl.cz;
      const co = Math.cos(isl.rot);
      const si = Math.sin(isl.rot);
      // 椭圆半径 + 噪声扰动的不规则海岸线
      const u = (dx * co + dz * si) / isl.rx;
      const v = (-dx * si + dz * co) / isl.rz;
      let d = Math.sqrt(u * u + v * v);
      const coastN = fbm2(this.coastNoise, x * 0.045 + isl.off, z * 0.045 - isl.off, 3);
      d -= coastN * 0.15;

      if (d >= 1.3) continue;

      let islandH;
      if (d >= 1.0) {
        // 水下岛架：从深海逐渐抬升到岸边浅滩（0.3 宽的过渡环）
        const t = 1 - smoothstep(1.0, 1.3, d); // 岸边=1，外侧=0
        islandH = THREE.MathUtils.lerp(SEA_FLOOR + 2.0, -0.9, t * t * (3 - 2 * t));
      } else {
        // 陆地：沙滩环 → 草地 → 岩壁 → 内陆山丘
        const inland = 1 - d;                       // 越靠近中心越大
        const hillF = smoothstep(0.06, 0.72, inland); // 山丘权重
        const detail = fbm2(this.detailNoise, x * 0.075 + isl.off, z * 0.075 + isl.off, 4);
        const ridge = ridge2(this.ridgeNoise, x * 0.05 - isl.off, z * 0.05 + isl.off, 4);
        const beachLift = 0.35 + 0.85 * smoothstep(0.0, 0.16, inland);
        const hills = hillF * isl.maxH * (0.55 + 0.45 * ridge) + detail * (1.0 + hillF * 5.5);
        islandH = beachLift + hills;
        // 海岸线压平，保证沙滩环连续
        islandH = THREE.MathUtils.lerp(0.28, islandH, smoothstep(0.0, 0.1, inland));
      }
      if (islandH > h) h = islandH;
    }
    return h;
  }

  /** 数值梯度求地表法线（用于树放置、搁浅检测等） */
  groundNormal(x, z, out) {
    const e = 1.2;
    const hL = this.heightAt(x - e, z);
    const hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e);
    const hU = this.heightAt(x, z + e);
    out.set(hL - hR, 2 * e, hD - hU).normalize();
    return out;
  }

  /** 水深（米）；陆地返回 0 */
  depthAt(x, z) {
    const g = this.heightAt(x, z);
    return g < WATER_LEVEL ? WATER_LEVEL - g : 0;
  }

  /** 世界边界外判定 */
  outsideWorld(x, z, margin = 6) {
    return Math.abs(x) > WORLD_HALF - margin || Math.abs(z) > WORLD_HALF - margin;
  }

  /**
   * 从某个中心向外螺旋搜索安全出生 / 重生点：水深足够、周围无暗礁陆地
   * @returns {{x:number,z:number,heading:number}}
   */
  findSafePosition(startX = 0, startZ = 0, minDepth = 9, clearRadius = 13) {
    for (let ring = 0; ring < 90; ring++) {
      const step = 6;
      const count = ring === 0 ? 1 : ring * 10;
      const angle0 = (this.seed % 360) * Math.PI / 180;
      for (let i = 0; i < count; i++) {
        const a = angle0 + (i / count) * Math.PI * 2 + ring * 0.7;
        const x = startX + Math.cos(a) * ring * step;
        const z = startZ + Math.sin(a) * ring * step;
        if (this.outsideWorld(x, z, 40)) continue;
        if (this.depthAt(x, z) < minDepth) continue;
        // 检查四周也为深水，避免出生在岛架边缘
        let clear = true;
        for (let k = 0; k < 6; k++) {
          const aa = (k / 6) * Math.PI * 2;
          if (this.depthAt(x + Math.cos(aa) * clearRadius, z + Math.sin(aa) * clearRadius) < minDepth - 2) {
            clear = false;
            break;
          }
        }
        if (clear) {
          return { x, z, heading: this.rng() * Math.PI * 2 };
        }
      }
    }
    // 兜底：世界中央深水
    return { x: 0, z: 0, heading: 0 };
  }
}

// ============================================================
// 程序化植被 / 礁石几何体（共享，低多边形）
// ============================================================

/** 棕榈树：弯曲树干 + 几片羽状叶 */
function buildPalmGeometry() {
  const trunkMat = new THREE.Color(0x8a5a2e);
  const leafMat = new THREE.Color(0x3f9e46);
  const trunk = new THREE.CylinderGeometry(0.16, 0.28, 3.2, 5, 2);
  trunk.translate(0, 1.6, 0);
  paint(trunk, trunkMat);
  const leaves = [];
  for (let i = 0; i < 5; i++) {
    const leaf = new THREE.ConeGeometry(0.55, 3.2, 4, 1, true);
    const a = (i / 5) * Math.PI * 2;
    leaf.translate(Math.cos(a) * 1.0, 3.25, Math.sin(a) * 1.0);
    leaf.rotateZ(Math.cos(a) * 1.05);
    leaf.rotateX(-Math.sin(a) * 1.05);
    paint(leaf, leafMat);
    leaves.push(leaf);
  }
  const geos = [trunk, ...leaves];
  return mergeGeometries(geos);
}

/** 松树：褐色树干 + 三层锥形针叶 */
function buildPineGeometry() {
  const trunk = new THREE.CylinderGeometry(0.22, 0.32, 1.6, 5, 1);
  trunk.translate(0, 0.8, 0);
  paint(trunk, new THREE.Color(0x714727));
  const tiers = [];
  const basePine = new THREE.Color(0x2f6e3a);
  for (let i = 0; i < 3; i++) {
    const r = 1.5 - i * 0.35;
    const h = 1.7;
    const cone = new THREE.ConeGeometry(r, h, 6, 1);
    cone.translate(0, 1.8 + i * 1.05, 0);
    const shade = basePine.clone();
    shade.offsetHSL(0, 0, i * 0.04);
    paint(cone, shade);
    tiers.push(cone);
  }
  return mergeGeometries([trunk, ...tiers]);
}

/** 礁石：随机多面体 */
function buildRockGeometry() {
  const rock = new THREE.DodecahedronGeometry(1, 0);
  const pos = rock.attributes.position;
  const rng = mulberry32(777);
  for (let i = 0; i < pos.count; i++) {
    const s = 0.75 + rng() * 0.5;
    pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * (0.55 + rng() * 0.35), pos.getZ(i) * (0.75 + rng() * 0.5));
  }
  pos.needsUpdate = true;
  rock.computeVertexNormals();
  paint(rock, new THREE.Color(0x8a8780));
  return rock;
}

/** 给整个几何体刷顶点色 */
function paint(geometry, color) {
  const count = geometry.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(arr, 3));
}

/**
 * 手写几何体合并：本项目所有几何都带 position / normal / color，
 * 合并后用一份 BufferGeometry 即可渲染（避免引入额外 addon）。
 */
function mergeGeometries(geometries) {
  let vCount = 0;
  let idxCount = 0;
  for (const g of geometries) {
    vCount += g.attributes.position.count;
    idxCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const idx = new Uint32Array(idxCount);
  let vo = 0;
  let io = 0;
  for (const g of geometries) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    col.set(g.attributes.color.array, vo * 3);
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
      io += src.length;
    } else {
      for (let i = 0; i < g.attributes.position.count; i++) idx[io + i] = vo + i;
      io += g.attributes.position.count;
    }
    vo += g.attributes.position.count;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  merged.setAttribute("color", new THREE.BufferAttribute(col, 3));
  merged.setIndex(new THREE.BufferAttribute(idx, 1));
  return merged;
}

// 风摆动共享 uniform（植被着色器使用）
export const windUniforms = {
  uTime: { value: 0 },
  uWindStrength: { value: 1 },
};

let worldRef = null;             // 当前 World 引用（Chunk 构建期间）
let vegetationDensity = 0.8;     // 当前画质对应的植被密度
const UP = new THREE.Vector3(0, 1, 0);

// 共享临时对象，避免热路径分配
const _n = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _pos = new THREE.Vector3();

/** 给植被材质注入顶点风摆（在实例的模型空间内摆动，仅高处弯曲） */
function injectSway(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uWindStrength;")
      .replace(
        "#include <project_vertex>",
        `#ifdef USE_INSTANCING
         float swayAmt = smoothstep(0.2, 4.5, transformed.y) * 0.16 * uWindStrength;
         transformed.x += sin(uTime * 2.1 + (instanceMatrix[3].x + instanceMatrix[3].z) * 0.08) * swayAmt;
         transformed.z += cos(uTime * 1.7 + (instanceMatrix[3].x - instanceMatrix[3].z) * 0.06) * swayAmt;
         #endif
         #include <project_vertex>`
      );
  };
}

// ============================================================
// Chunk：单个地形区块（合并 BufferGeometry + 植被 / 礁石实例）
// ============================================================
class Chunk {
  constructor(world, cx, cz, highDetail) {
    this.world = world;
    this.cx = cx;
    this.cz = cz;
    this.highDetail = highDetail;
    this.group = new THREE.Group();
    this.group.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    this.disposed = false;
    this.terrainMesh = null;
    this.vegetation = [];
    this._build();
  }

  /** 高精度 8m 间距，低精度 16m；四周加固定深度裙边，杜绝 LOD 裂缝 */
  _build() {
    const w = this.world;
    const step = this.highDetail ? 8 : 16;
    const seg = CHUNK_SIZE / step;
    const vps = seg + 1;
    const x0 = this.cx * CHUNK_SIZE;
    const z0 = this.cz * CHUNK_SIZE;

    // ---- 地表 ----
    const vCount = vps * vps;
    const pos = new Float32Array(vCount * 3);
    const col = new Float32Array(vCount * 3);
    for (let iz = 0; iz <= seg; iz++) {
      for (let ix = 0; ix <= seg; ix++) {
        const wx = x0 + ix * step;
        const wz = z0 + iz * step;
        const h = w.heightAt(wx, wz);
        const vi = iz * vps + ix;
        pos[vi * 3] = ix * step;
        pos[vi * 3 + 1] = h;
        pos[vi * 3 + 2] = iz * step;
      }
    }
    // 顶点色（坡度由相邻高度的中心差分得到，避免每顶点 4 次噪声查询）
    for (let iz = 0; iz <= seg; iz++) {
      for (let ix = 0; ix <= seg; ix++) {
        const wx = x0 + ix * step;
        const wz = z0 + iz * step;
        const vi = iz * vps + ix;
        const h = pos[vi * 3 + 1];
        const hL = ix > 0 ? pos[(iz * vps + ix - 1) * 3 + 1] : w.heightAt(wx - step, wz);
        const hR = ix < seg ? pos[(iz * vps + ix + 1) * 3 + 1] : w.heightAt(wx + step, wz);
        const hD = iz > 0 ? pos[((iz - 1) * vps + ix) * 3 + 1] : w.heightAt(wx, wz - step);
        const hU = iz < seg ? pos[((iz + 1) * vps + ix) * 3 + 1] : w.heightAt(wx, wz + step);
        vertexColor(w, wx, wz, h, col, vi * 3, hL, hR, hD, hU, step);
      }
    }
    const surfIdx = new Uint32Array(seg * seg * 6);
    let p = 0;
    for (let iz = 0; iz < seg; iz++) {
      for (let ix = 0; ix < seg; ix++) {
        const a = iz * vps + ix;
        const b = a + 1;
        const c = a + vps;
        surfIdx[p++] = a; surfIdx[p++] = c; surfIdx[p++] = b;
        surfIdx[p++] = b; surfIdx[p++] = c; surfIdx[p++] = c + 1;
      }
    }

    // ---- 四周裙边 ----
    const ringV = seg * 8;
    const skirtPos = new Float32Array(ringV * 3);
    const skirtCol = new Float32Array(ringV * 3);
    const skirtIdx = new Uint32Array(seg * 4 * 6);
    let sv = 0;
    let si = 0;
    const edge = (ax, az, bx, bz) => {
      const base = sv;
      const ha = w.heightAt(x0 + ax * step, z0 + az * step);
      const hb = w.heightAt(x0 + bx * step, z0 + bz * step);
      const pushV = (gx, gy, gz) => {
        skirtPos[sv * 3] = gx;
        skirtPos[sv * 3 + 1] = gy;
        skirtPos[sv * 3 + 2] = gz;
        skirtCol[sv * 3] = C_DEEPBOTTOM.r;
        skirtCol[sv * 3 + 1] = C_DEEPBOTTOM.g;
        skirtCol[sv * 3 + 2] = C_DEEPBOTTOM.b;
        sv++;
      };
      pushV(ax * step, ha, az * step);
      pushV(ax * step, ha - SKIRT_DEPTH, az * step);
      pushV(bx * step, hb, bz * step);
      pushV(bx * step, hb - SKIRT_DEPTH, bz * step);
      // 统一的环绕顺序，配合双面渲染
      skirtIdx[si++] = base; skirtIdx[si++] = base + 1; skirtIdx[si++] = base + 2;
      skirtIdx[si++] = base + 2; skirtIdx[si++] = base + 1; skirtIdx[si++] = base + 3;
    };
    for (let i = 0; i < seg; i++) {
      edge(i, 0, i + 1, 0);      // 北
      edge(i + 1, seg, i, seg);  // 南
      edge(0, i + 1, 0, i);      // 西
      edge(seg, i, seg, i + 1);  // 东
    }

    // ---- 合并为单个 BufferGeometry（每块只有一个地形 draw call） ----
    const totalV = vCount + ringV;
    const allPos = new Float32Array(totalV * 3);
    const allCol = new Float32Array(totalV * 3);
    allPos.set(pos, 0);
    allCol.set(col, 0);
    allPos.set(skirtPos, vCount * 3);
    allCol.set(skirtCol, vCount * 3);
    for (let i = 0; i < skirtIdx.length; i++) skirtIdx[i] += vCount;
    const allIdx = new Uint32Array(surfIdx.length + skirtIdx.length);
    allIdx.set(surfIdx, 0);
    allIdx.set(skirtIdx, surfIdx.length);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(allPos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(allCol, 3));
    geo.setIndex(new THREE.BufferAttribute(allIdx, 1));
    geo.computeVertexNormals();

    this.terrainMesh = new THREE.Mesh(geo, w.terrainMaterial);
    this.terrainMesh.receiveShadow = true;
    this.group.add(this.terrainMesh);

    this._populateDetails(x0, z0);
  }

  /** 确定性放置棕榈 / 松树 / 礁石（仅高精度块） */
  _populateDetails(x0, z0) {
    const w = this.world;
    if (!this.highDetail) return;

    const palms = [];
    const pines = [];
    const rocks = [];
    const cell = 4;
    const n = CHUNK_SIZE / cell;

    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const lx = x0 + ix * cell;
        const lz = z0 + iz * cell;
        // 由世界坐标 + 种子派生伪随机，保证区块卸载重建后一致
        let s = ((Math.imul(lx, 73856093) ^ Math.imul(lz, 19349663)) ^ w.seed) >>> 0;
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const r1 = s / 4294967296;
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const r2 = s / 4294967296;

        const wx = lx + (r1 - 0.5) * 2.4;
        const wz = lz + (r2 - 0.5) * 2.4;
        const h = w.heightAt(wx, wz);
        w.groundNormal(wx, wz, _n);

        // 礁石：海岸线与浅滩
        if (h > -1.7 && h < 0.9 && r1 < 0.11) {
          rocks.push({ x: wx - x0, y: h + 0.2, z: wz - z0, s: 0.5 + r2 * 1.2 });
          continue;
        }
        // 植被：草地、坡度平缓
        if (h > 1.1 && h < 17 && _n.y > 0.8 && r1 < 0.34 * vegetationDensity) {
          if (h < 3.4 && r2 < 0.65) {
            palms.push({ x: wx - x0, y: h, z: wz - z0, s: 0.75 + r2 * 0.5 });
          } else {
            pines.push({ x: wx - x0, y: h, z: wz - z0, s: 0.7 + r2 * 0.75 });
          }
        }
      }
    }

    this._makeInstances(w.palmGeometry, palms, true);
    this._makeInstances(w.pineGeometry, pines, true);
    this._makeInstances(w.rockGeometry, rocks, false);
  }

  /** 生成一类 InstancedMesh（植被带风摆） */
  _makeInstances(geometry, items, sway) {
    if (!items.length) return;
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
    });
    if (sway) injectSway(material);

    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.receiveShadow = true;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      _pos.set(it.x, it.y, it.z);
      _q.setFromAxisAngle(UP, (i * 2.399) % (Math.PI * 2));
      _scl.set(it.s, it.s, it.s);
      _m4.compose(_pos, _q, _scl);
      mesh.setMatrixAt(i, _m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this.vegetation.push(mesh);
  }

  /** 真正释放 GPU 资源（不只是隐藏），保证内存不随航行持续增长 */
  dispose() {
    this.disposed = true;
    this.terrainMesh.geometry.dispose();
    for (const mesh of this.vegetation) {
      mesh.material.dispose();
    }
  }
}

/** 区块地貌顶点色（坡度由中心差分法线得到，无需再查噪声） */
function vertexColor(w, wx, wz, h, col, off, hL, hR, hD, hU, e) {
  _n.set(hL - hR, 2 * e, hD - hU).normalize();
  const slope = 1 - Math.max(0, _n.y);
  const mottle = fbm2(w.detailNoise, wx * 0.22, wz * 0.22, 2) * 0.5 + 0.5;

  if (h < -0.15) {
    _c.copy(C_UNDERWATER).lerp(C_DEEPBOTTOM, smoothstep(-0.5, SEA_FLOOR + 4, h));
  } else if (h < 1.05) {
    _c.copy(C_SAND).lerp(C_SAND_DRY, smoothstep(0.05, 1.05, h));
  } else {
    const hill = smoothstep(9, 22, h);
    if (slope > 0.42 || h > 20) {
      _c.copy(C_ROCK).lerp(C_ROCK_DARK, Math.min(1, slope * 1.3));
    } else if (hill > 0) {
      _c.copy(C_GRASS_DARK).lerp(C_HILL, hill);
    } else {
      _c.copy(C_GRASS).lerp(C_GRASS_DARK, mottle * 0.55);
    }
  }
  const shade = 0.9 + Math.floor(mottle * 4) * 0.035;
  col[off] = Math.min(1, _c.r * shade);
  col[off + 1] = Math.min(1, _c.g * shade);
  col[off + 2] = Math.min(1, _c.b * shade);
}

// ============================================================
// ChunkManager：按玩家视距动态加载 / 卸载区块，稳定内存
// ============================================================
export class ChunkManager {
  /**
   * @param {THREE.Scene} scene
   * @param {World} world
   * @param {{vegetation:number, shadows:boolean}} quality
   */
  constructor(scene, world, quality) {
    this.scene = scene;
    this.world = world;
    this.chunks = new Map();   // key -> Chunk
    this.buildQueue = [];
    this.viewRadius = 3;

    worldRef = world;
    vegetationDensity = quality.vegetation;

    // 共享地形材质（顶点色 + 平面着色 = 低多边形卡通）
    world.terrainMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
      side: THREE.DoubleSide, // 裙边朝内的三角也能正确渲染
    });

    // 共享植被 / 礁石几何体
    world.palmGeometry = buildPalmGeometry();
    world.pineGeometry = buildPineGeometry();
    world.rockGeometry = buildRockGeometry();
  }

  setViewRadius(r) {
    this.viewRadius = Math.max(1, Math.min(5, r | 0));
  }

  setVegetation(density) {
    vegetationDensity = density;
    // 植被密度变化：重建高精度块（地形本身不变）
    for (const [key, chunk] of this.chunks) {
      if (chunk.highDetail) {
        this._removeChunk(key, chunk);
        this.buildQueue.push({ cx: chunk.cx, cz: chunk.cz, high: true });
      }
    }
  }

  get chunkCount() {
    return this.chunks.size;
  }

  /** 每帧调用：决定需要哪些块，卸载超距块，按预算构建新块 */
  update(px, pz, buildBudget = 2) {
    const pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = Math.floor(pz / CHUNK_SIZE);
    const minC = -CHUNKS_X / 2;
    const maxC = CHUNKS_X / 2 - 1;
    const r = this.viewRadius;
    this._neededSet = this._neededSet || new Set();
    this._wanted = this._wanted || [];
    const needed = this._neededSet;
    const wanted = this._wanted;
    needed.clear();
    wanted.length = 0;

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > (r + 0.5) * (r + 0.5)) continue;
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (cx < minC || cx > maxC || cz < minC || cz > maxC) continue;
        const key = cx + "," + cz;
        needed.add(key);
        wanted.push({ cx, cz, dx, dz, high: Math.abs(dx) <= 1 && Math.abs(dz) <= 1 });
      }
    }

    // 卸载不再需要的区块（真正 dispose，释放显存）
    for (const [key, chunk] of this.chunks) {
      if (!needed.has(key)) {
        this._removeChunk(key, chunk);
      }
    }

    // 需要新建或 LOD 变化的区块
    this._queuedSet = this._queuedSet || new Set();
    const queuedKeys = this._queuedSet;
    queuedKeys.clear();
    for (const info of wanted) {
      const key = info.cx + "," + info.cz;
      const existing = this.chunks.get(key);
      if (!existing || existing.highDetail !== info.high) {
        if (existing) this._removeChunk(key, existing);
        if (!queuedKeys.has(key)) {
          this.buildQueue.push({ cx: info.cx, cz: info.cz, high: info.high });
          queuedKeys.add(key);
        }
      }
    }

    // 按离玩家的距离排序构建队列，近的先生成
    this.buildQueue.sort((a, b) => {
      const da = (a.cx - pcx) * (a.cx - pcx) + (a.cz - pcz) * (a.cz - pcz);
      const db = (b.cx - pcx) * (b.cx - pcx) + (b.cz - pcz) * (b.cz - pcz);
      return da - db;
    });

    // 每帧构建少量块，避免卡顿；出队前确认该块仍在视距内
    let built = 0;
    while (this.buildQueue.length && built < buildBudget) {
      const job = this.buildQueue.shift();
      const key = job.cx + "," + job.cz;
      if (this.chunks.has(key) || !needed.has(key)) continue;
      const chunk = new Chunk(this.world, job.cx, job.cz, job.high);
      this.chunks.set(key, chunk);
      this.scene.add(chunk.group);
      built++;
    }
    // 队列中残留的过期任务直接丢弃（防止驶离后仍堆积构建）
    if (this.buildQueue.length > 40) {
      this.buildQueue = this.buildQueue.filter((j) => needed.has(j.cx + "," + j.cz));
    }
  }

  _removeChunk(key, chunk) {
    this.scene.remove(chunk.group);
    chunk.dispose();
    this.chunks.delete(key);
  }

  /** 离开游戏 / 重置世界时全部卸载 */
  disposeAll() {
    for (const [key, chunk] of this.chunks) this._removeChunk(key, chunk);
    this.buildQueue.length = 0;
    if (this.world.terrainMaterial) this.world.terrainMaterial.dispose();
    if (this.world.palmGeometry) this.world.palmGeometry.dispose();
    if (this.world.pineGeometry) this.world.pineGeometry.dispose();
    if (this.world.rockGeometry) this.world.rockGeometry.dispose();
  }
}
