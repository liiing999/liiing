// world.js —— 程序化群岛世界：多层噪声高度场、动态区块加载、两级 LOD、植被与礁石。

import * as THREE from 'three';
import { mulberry32, fbm2, ridged2, hash2 } from './noise.js';

export const CHUNK_SIZE = 64;      // 单块世界尺寸（世界单位）
export const WORLD_CHUNKS = 12;    // 世界为 12 x 12 块
export const WORLD_SIZE = CHUNK_SIZE * WORLD_CHUNKS; // 768
export const WORLD_HALF = WORLD_SIZE / 2;            // 384

// 高/低精度网格分段数（两级 LOD）
const SEG_HIGH = 24;
const SEG_LOW = 12;
// 区块下方裙边深度：封住边缘并消除相邻 LOD 的视觉裂缝
const SKIRT_DEPTH = 26;

/**
 * 世界。负责地形高度采样、区块动态生成 / 卸载、植被与礁石实例化。
 */
export class World {
  /**
   * @param {THREE.Scene} scene
   * @param {number} seed 世界种子
   * @param {{quality?: string}} [options]
   */
  constructor(scene, seed, options = {}) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.quality = options.quality || 'medium';

    // 由种子确定性生成的岛屿列表
    this.islands = [];
    this._generateIslands();

    // 已加载区块：key "cx,cz" -> Chunk 对象
    this.chunks = new Map();
    // 视距（区块半径），由设置控制
    this.viewRadius = 4;

    // 共享地形材质（顶点着色）
    this.terrainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

    // 植被密度按画质档位
    this.treeDensity = this.quality === 'high' ? 1.0 : this.quality === 'low' ? 0.35 : 0.65;
    this.treesPerChunk = this.quality === 'high' ? 26 : this.quality === 'low' ? 8 : 16;

    this._buildTreeAssets();

    // 礁石共享几何体（低多边形二十面体）
    this.rockGeometry = new THREE.IcosahedronGeometry(1, 0);
    this.rockMaterial = new THREE.MeshLambertMaterial({ color: 0x6d6a63, flatShading: true });
  }

  /** 用种子决定岛屿位置、大小与峰高，避开出生点附近开阔水域。 */
  _generateIslands() {
    const rand = mulberry32(this.seed);
    const count = 16;
    let attempts = 0;
    while (this.islands.length < count && attempts < 400) {
      attempts++;
      const x = (rand() * 2 - 1) * (WORLD_HALF - 70);
      const z = (rand() * 2 - 1) * (WORLD_HALF - 70);
      const radius = 34 + rand() * 34;
      // 出生点附近保留开阔水域
      if (Math.hypot(x, z) < radius + 95) continue;
      // 岛屿之间保持间隔（允许少量重叠以形成群岛感）
      let ok = true;
      for (const isl of this.islands) {
        if (Math.hypot(x - isl.x, z - isl.z) < (radius + isl.radius) * 0.72) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      this.islands.push({
        x, z, radius,
        height: 15 + rand() * 17,
        phaseX: rand() * 200,
        phaseZ: rand() * 200
      });
    }
  }

  /**
   * 地表高度（世界坐标）。正值为陆地，负值为海底。
   * 该函数被网格生成、浮力采样、小地图、碰撞共同使用，必须保持确定性。
   * @param {number} wx
   * @param {number} wz
   * @returns {number}
   */
  getHeight(wx, wz) {
    let h = -16; // 深海基底
    let bestInfluence = 0;

    for (const isl of this.islands) {
      const dx = wx - isl.x;
      const dz = wz - isl.z;
      const dist = Math.hypot(dx, dz);
      if (dist > isl.radius * 1.5) continue;

      const t = Math.max(0, 1 - dist / (isl.radius * 1.35));
      const influence = t * t * (3 - 2 * t); // smoothstep 包络
      if (influence > bestInfluence) bestInfluence = influence;

      const ridge = ridged2(
        wx / isl.radius + isl.phaseX,
        wz / isl.radius + isl.phaseZ,
        this.seed + 7,
        4
      );
      const detail = fbm2(wx / 14 + isl.phaseX, wz / 14 + isl.phaseZ, this.seed + 3, 3);
      const envelope = influence * isl.height;
      const islH = -4 + envelope * (0.45 + ridge * 0.9) + detail * 2.2 * influence;
      h = Math.max(h, islH);
    }

    // 开阔海底起伏
    const oceanFloor = fbm2(wx / 90, wz / 90, this.seed + 99, 3) * 7 - 3;
    if (bestInfluence < 0.35) h += oceanFloor * (1 - bestInfluence);

    // 稀疏暗礁：把世界划成 9 单位格子，用哈希在少量格子中放一块尖礁
    const cellX = Math.floor(wx / 9);
    const cellZ = Math.floor(wz / 9);
    const reefRoll = hash2(cellX, cellZ, this.seed + 555);
    if (reefRoll > 0.985) {
      const rx = cellX * 9 + hash2(cellX, cellZ, this.seed + 556) * 9;
      const rz = cellZ * 9 + hash2(cellX, cellZ, this.seed + 557) * 9;
      const rd = Math.hypot(wx - rx, wz - rz);
      if (rd < 3.2) {
        const bump = (1 - rd / 3.2) * 4.5;
        h = Math.max(h, -1.2 + bump);
      }
    }
    return h;
  }

  /**
   * 依据高度与坡度返回地表颜色（沙滩 / 草地 / 岩壁 / 内陆山丘）。
   * @param {number} wx
   * @param {number} wz
   * @param {number} h
   * @param {THREE.Color} out
   */
  getColor(wx, wz, h, out) {
    const e = 1.4;
    const hx = this.getHeight(wx + e, wz);
    const hz = this.getHeight(wx, wz + e);
    const slope = Math.hypot(hx - h, hz - h) / e;

    if (h < -0.3) {
      // 水下：浅沙 → 深泥
      if (h > -3.5) out.setRGB(0.76, 0.7, 0.46);
      else if (h > -8) out.setRGB(0.45, 0.42, 0.28);
      else out.setRGB(0.16, 0.22, 0.2);
      return;
    }
    if (h < 1.6) { // 沙滩
      out.setRGB(0.86, 0.8, 0.55);
      return;
    }
    if (slope > 0.95 || h > 21) { // 岩壁 / 高峰裸岩
      const g = 0.38 + 0.1 * Math.sin(wx * 0.7 + wz * 0.5);
      out.setRGB(g, g * 0.95, g * 0.9);
      return;
    }
    if (h > 12) { // 内陆山丘高地
      out.setRGB(0.42, 0.52, 0.25);
    } else { // 草地，用哈希制造细碎色差
      const variation = hash2(Math.floor(wx / 3), Math.floor(wz / 3), this.seed + 31) * 0.12;
      out.setRGB(0.36 + variation, 0.62 + variation * 0.6, 0.28);
    }
  }

  /** 构造棕榈 / 松树的几何体与带风摆动的材质。 */
  _buildTreeAssets() {
    // ---- 棕榈 ----
    const trunk = new THREE.CylinderGeometry(0.16, 0.28, 3.2, 5);
    trunk.translate(0, 1.6, 0);
    const leaves = new THREE.ConeGeometry(1.7, 2.0, 6);
    leaves.translate(0, 3.4, 0);
    const fronds = new THREE.BufferGeometry();
    const frondPos = [];
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      const ex = Math.cos(ang) * 2.1;
      const ez = Math.sin(ang) * 2.1;
      frondPos.push(0, 3.4, 0, ex, 2.7, ez);
      frondPos.push(0, 3.4, 0, ex * 0.6, 3.0, ez * 0.6);
    }
    fronds.setAttribute('position', new THREE.Float32BufferAttribute(frondPos, 3));
    this.palmGeometries = [trunk, leaves, fronds];
    this.palmTrunkMaterial = this._makeWindMaterial(0x7a5230, false);
    this.palmLeafMaterial = this._makeWindMaterial(0x3f8f3a, true);

    // ---- 松树：直干 + 三层圆锥 ----
    const pineTrunk = new THREE.CylinderGeometry(0.18, 0.26, 2.0, 5);
    pineTrunk.translate(0, 1.0, 0);
    const pine1 = new THREE.ConeGeometry(1.5, 2.2, 6);
    pine1.translate(0, 2.4, 0);
    const pine2 = new THREE.ConeGeometry(1.1, 1.9, 6);
    pine2.translate(0, 3.5, 0);
    const pine3 = new THREE.ConeGeometry(0.7, 1.5, 6);
    pine3.translate(0, 4.5, 0);
    this.pineGeometries = [pineTrunk, pine1, pine2, pine3];
    this.pineTrunkMaterial = this._makeWindMaterial(0x6a4628, false);
    this.pineLeafMaterial = this._makeWindMaterial(0x2f6b40, true);
  }

  /**
   * 创建 Lambert 材质并注入顶点着色器风摆动代码（供实例化植被使用）。
   * @param {number} color
   * @param {boolean} sway 叶片强摆动，树干弱摆动
   * @returns {THREE.MeshLambertMaterial}
   */
  _makeWindMaterial(color, sway) {
    const mat = new THREE.MeshLambertMaterial({ color, flatShading: true });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uWind = { value: 0.5 };
      shader.vertexShader =
        'uniform float uTime;\nuniform float uWind;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '#ifdef USE_INSTANCING',
            'vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);',
            'float windPhase = uTime * 1.7 + iPos.x * 0.15 + iPos.z * 0.12;',
            'float swayAmt = ' + (sway ? '0.16' : '0.02') + ' * uWind;',
            'transformed.x += sin(windPhase) * swayAmt * smoothstep(0.0, 4.0, position.y);',
            'transformed.z += cos(windPhase * 0.8) * swayAmt * 0.7 * smoothstep(0.0, 4.0, position.y);',
            '#endif'
          ].join('\n')
        );
      mat.userData.shader = shader;
    };
    return mat;
  }

  /** 每帧更新植被风摆动 uniform。 */
  updateWind(time, windStrength) {
    const mats = [
      this.palmTrunkMaterial, this.palmLeafMaterial,
      this.pineTrunkMaterial, this.pineLeafMaterial
    ];
    for (const mat of mats) {
      const shader = mat.userData.shader;
      if (shader) {
        shader.uniforms.uTime.value = time;
        shader.uniforms.uWind.value = windStrength;
      }
    }
  }

  /**
   * 生成单块地形：一个合并的 BufferGeometry + 四周下垂裙边。
   * 裙边让高/低 LOD 相邻时不会出现可见裂缝或空洞。
   * @param {number} cx
   * @param {number} cz
   * @param {number} segments
   * @returns {THREE.BufferGeometry}
   */
  _buildChunkGeometry(cx, cz, segments) {
    const positions = [];
    const colors = [];
    const indices = [];
    const color = new THREE.Color();

    const x0 = -WORLD_HALF + cx * CHUNK_SIZE;
    const z0 = -WORLD_HALF + cz * CHUNK_SIZE;
    const step = CHUNK_SIZE / segments;
    const cols = segments + 1;

    // 顶面网格
    for (let iz = 0; iz <= segments; iz++) {
      for (let ix = 0; ix <= segments; ix++) {
        const wx = x0 + ix * step;
        const wz = z0 + iz * step;
        const h = this.getHeight(wx, wz);
        positions.push(wx, h, wz);
        this.getColor(wx, wz, h, color);
        colors.push(color.r, color.g, color.b);
      }
    }
    for (let iz = 0; iz < segments; iz++) {
      for (let ix = 0; ix < segments; ix++) {
        const a = iz * cols + ix;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    // 沿四条边构造下垂裙边：复制边界顶点并压到 SKIRT_DEPTH
    const skirtRows = [];
    for (let ix = 0; ix <= segments; ix++) skirtRows.push(ix);                       // 北边
    for (let iz = 1; iz <= segments; iz++) skirtRows.push(iz * cols + segments);    // 东边
    for (let ix = segments - 1; ix >= 0; ix--) skirtRows.push(segments * cols + ix);// 南边
    for (let iz = segments - 1; iz >= 1; iz--) skirtRows.push(iz * cols);           // 西边

    const skirtTop = [];
    const skirtBottom = [];
    for (const idx of skirtRows) {
      const vx = positions[idx * 3];
      const vy = positions[idx * 3 + 1];
      const vz = positions[idx * 3 + 2];
      skirtTop.push(positions.length / 3);
      positions.push(vx, vy, vz);
      colors.push(0.12, 0.16, 0.15);
      skirtBottom.push(positions.length / 3);
      positions.push(vx, vy - SKIRT_DEPTH, vz);
      colors.push(0.08, 0.11, 0.1);
    }
    for (let i = 0; i < skirtTop.length; i++) {
      const j = (i + 1) % skirtTop.length;
      const topA = skirtTop[i];
      const botA = skirtBottom[i];
      const topB = skirtTop[j];
      const botB = skirtBottom[j];
      indices.push(topA, botA, topB, topB, botA, botB);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  /**
   * 用 InstancedMesh 在一块区块内放置棕榈 / 松树与水面礁石。
   * 位置由区块坐标 + 哈希决定，保证卸载重建后位置一致。
   * @param {number} cx
   * @param {number} cz
   * @returns {THREE.Group}
   */
  _buildChunkProps(cx, cz) {
    const group = new THREE.Group();
    const x0 = -WORLD_HALF + cx * CHUNK_SIZE;
    const z0 = -WORLD_HALF + cz * CHUNK_SIZE;

    const palms = [];
    const pines = [];
    const rocks = [];
    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();

    const attempts = Math.floor(this.treesPerChunk / this.treeDensity);
    for (let i = 0; i < attempts; i++) {
      const rx = hash2(cx * 131 + i, cz * 17 + 3, this.seed + 101);
      const rz = hash2(cx * 131 + i, cz * 17 + 7, this.seed + 202);
      const densityRoll = hash2(cx * 131 + i, cz * 17 + 9, this.seed + 303);
      if (densityRoll > this.treeDensity) continue;
      const wx = x0 + rx * CHUNK_SIZE;
      const wz = z0 + rz * CHUNK_SIZE;
      const h = this.getHeight(wx, wz);
      // 树木只长在草地上（2~20 高度），沙滩与裸岩不长
      if (h < 2 || h > 20) continue;
      const isPalm = h < 7 || hash2(i, cx + cz, this.seed + 404) > 0.55;
      const s = 0.8 + hash2(i, cx, cz + this.seed) * 0.5;
      pos.set(wx, h - 0.1, wz);
      euler.set(0, rx * Math.PI * 2, 0);
      quat.setFromEuler(euler);
      scale.set(s, s, s);
      matrix.compose(pos, quat, scale);
      (isPalm ? palms : pines).push(matrix.clone());
    }

    // 水面礁石（高度在 -2.5 ~ 1 之间才露出或接近水面）
    for (let i = 0; i < 10; i++) {
      const rx = hash2(cx * 911 + i, cz * 53 + 1, this.seed + 505);
      const rz = hash2(cx * 911 + i, cz * 53 + 5, this.seed + 606);
      const wx = x0 + rx * CHUNK_SIZE;
      const wz = z0 + rz * CHUNK_SIZE;
      const h = this.getHeight(wx, wz);
      if (h < -2.6 || h > 1.2) continue;
      const s = 0.5 + hash2(i + 3, cx + cz, this.seed) * 1.1;
      pos.set(wx, h + 0.1, wz);
      euler.set(rx * 3, rz * 3, rx * 2);
      quat.setFromEuler(euler);
      scale.set(s, s * (0.5 + rx * 0.5), s);
      matrix.compose(pos, quat, scale);
      rocks.push(matrix.clone());
    }

    this._addInstancedSet(group, this.palmGeometries,
      [this.palmTrunkMaterial, this.palmLeafMaterial, this.palmLeafMaterial], palms);
    this._addInstancedSet(group, this.pineGeometries,
      [this.pineTrunkMaterial, this.pineLeafMaterial, this.pineLeafMaterial, this.pineLeafMaterial], pines);

    if (rocks.length > 0) {
      const rockMesh = new THREE.InstancedMesh(this.rockGeometry, this.rockMaterial, rocks.length);
      rocks.forEach((m, i) => rockMesh.setMatrixAt(i, m));
      rockMesh.instanceMatrix.needsUpdate = true;
      rockMesh.castShadow = this.quality === 'high';
      group.add(rockMesh);
    }
    return group;
  }

  /**
   * 把一套几何体（如树干+树叶）分别构建为 InstancedMesh，共用同一批实例矩阵。
   * @param {THREE.Group} group
   * @param {THREE.BufferGeometry[]} geometries
   * @param {THREE.Material[]} materials
   * @param {THREE.Matrix4[]} matrices
   */
  _addInstancedSet(group, geometries, materials, matrices) {
    if (matrices.length === 0) return;
    for (let part = 0; part < geometries.length; part++) {
      const mesh = new THREE.InstancedMesh(geometries[part], materials[part], matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = this.quality === 'high';
      group.add(mesh);
    }
  }

  /**
   * 创建并加入一个区块。
   * @param {number} cx
   * @param {number} cz
   * @param {number} segments
   * @returns {{group: THREE.Group, geometry: THREE.BufferGeometry}}
   */
  _createChunk(cx, cz, segments) {
    const geometry = this._buildChunkGeometry(cx, cz, segments);
    const mesh = new THREE.Mesh(geometry, this.terrainMaterial);
    mesh.receiveShadow = this.quality === 'high';
    const group = new THREE.Group();
    group.add(mesh);
    group.add(this._buildChunkProps(cx, cz));
    this.scene.add(group);
    return { group, geometry };
  }

  /**
   * 依据玩家所在区块与视距动态加载 / 卸载区块。
   * 每帧最多创建少量区块，避免一次性生成造成卡顿；卸载会真正释放几何体显存。
   * @param {number} playerX
   * @param {number} playerZ
   * @param {number} maxCreate 本帧最多新建区块数
   * @returns {number} 本次实际新建数量
   */
  update(playerX, playerZ, maxCreate = 2) {
    const pcx = Math.floor((playerX + WORLD_HALF) / CHUNK_SIZE);
    const pcz = Math.floor((playerZ + WORLD_HALF) / CHUNK_SIZE);
    const radius = this.viewRadius;

    // 需要的区块集合，距离越近精度越高（两级 LOD）
    const wanted = new Map();
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (cx < 0 || cz < 0 || cx >= WORLD_CHUNKS || cz >= WORLD_CHUNKS) continue;
        if (dx * dx + dz * dz > (radius + 0.4) * (radius + 0.4)) continue;
        const dist = Math.hypot(dx, dz);
        const segments = dist <= 1.6 ? SEG_HIGH : SEG_LOW;
        wanted.set(cx + ',' + cz, segments);
      }
    }

    // 卸载超出视距的区块（真正 dispose 几何体，防止内存持续增长）
    for (const [key, chunk] of this.chunks) {
      if (!wanted.has(key)) {
        this.scene.remove(chunk.group);
        chunk.geometry.dispose();
        // InstancedMesh 无独立几何体（全部共享），无需逐个释放
        this.chunks.delete(key);
      }
    }

    // 加载新区块或在 LOD 变化时重建；优先建离玩家近的
    let created = 0;
    const pending = [];
    for (const [key, segments] of wanted) {
      const existing = this.chunks.get(key);
      if (!existing) {
        const [cx, cz] = key.split(',').map(Number);
        const d = Math.hypot(cx - pcx, cz - pcz);
        pending.push({ key, cx, cz, segments, d });
      }
    }
    pending.sort((a, b) => a.d - b.d);
    for (const item of pending) {
      if (created >= maxCreate) break;
      this.chunks.set(item.key, this._createChunk(item.cx, item.cz, item.segments));
      created++;
    }
    return created;
  }

  /** 当前已加载区块数量（调试用）。 */
  get chunkCount() {
    return this.chunks.size;
  }

  /** 释放全部区块与共享资源（重置世界时调用）。 */
  dispose() {
    for (const chunk of this.chunks.values()) {
      this.scene.remove(chunk.group);
      chunk.geometry.dispose();
    }
    this.chunks.clear();
    this.terrainMaterial.dispose();
    this.rockGeometry.dispose();
    this.rockMaterial.dispose();
    for (const geo of [...this.palmGeometries, ...this.pineGeometries]) geo.dispose();
    [
      this.palmTrunkMaterial, this.palmLeafMaterial,
      this.pineTrunkMaterial, this.pineLeafMaterial
    ].forEach((m) => m.dispose());
  }
}
