// ============================================================
// save.js —— localStorage 存档、设置与移动端检测
// ============================================================

const SAVE_KEY = "endless-archipelago-save-v1";

/** 默认玩家设置 */
export const DEFAULT_SETTINGS = {
  viewDistance: 3, // 区块半径（块）
  sensitivity: 1.0,
  quality: "medium", // low / medium / high
};

/** 不同画质档位：波高倍数、植被密度、阴影开关 */
export const QUALITY_PRESETS = {
  low: { waveScale: 0.7, vegetation: 0.45, shadows: false, oceanSeg: 96 },
  medium: { waveScale: 1.0, vegetation: 0.8, shadows: true, oceanSeg: 128 },
  high: { waveScale: 1.25, vegetation: 1.0, shadows: true, oceanSeg: 160 },
};

/** 是否为移动 / 触屏设备（用于提示“建议使用桌面浏览器”） */
export function isMobileDevice() {
  const touch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const narrow = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  const ua = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return (touch && narrow) || ua;
}

/** 是否存在可恢复的存档 */
export function hasSave() {
  try {
    return localStorage.getItem(SAVE_KEY) !== null;
  } catch (e) {
    return false;
  }
}

/** 读取存档（失败返回 null） */
export function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // 合并默认设置，避免旧档缺字段
    data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    return data;
  } catch (e) {
    console.warn("存档读取失败：", e);
    return null;
  }
}

/** 写入存档 */
export function saveGame(data) {
  try {
    data.version = 1;
    data.savedAt = Date.now();
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.warn("存档写入失败：", e);
    return false;
  }
}

/** 清除存档 */
export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch (e) {
    console.warn("存档清除失败：", e);
  }
}

/** 存档摘要（开始界面显示） */
export function describeSave(data) {
  if (!data) return "";
  const pos = data.ship && data.ship.position;
  const kills = data.sunkEnemies ? data.sunkEnemies.length : 0;
  const disc = data.discoveredEnemies ? data.discoveredEnemies.length : 0;
  const mapped = data.mappedIslands ? data.mappedIslands.length : 0;
  const where = pos ? ` 坐标 (${pos.x.toFixed(0)}, ${pos.z.toFixed(0)})` : "";
  return `存档种子 ${data.seed}　击沉海盗 ${kills} 艘　发现 ${disc} 艘　测绘岛屿 ${mapped}${where}`;
}
