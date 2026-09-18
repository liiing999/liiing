// save.js —— 把世界种子、船只状态、战果、测绘与设置保存到 localStorage。

const SAVE_KEY = 'endless-archipelago-save-v1';

/**
 * 保存游戏状态。
 * @param {object} state
 * @returns {boolean} 是否写入成功
 */
export function saveGame(state) {
  try {
    const payload = {
      version: 1,
      savedAt: Date.now(),
      ...state
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn('保存失败：', err);
    return false;
  }
}

/**
 * 读取存档，不存在或损坏时返回 null。
 * @returns {object|null}
 */
export function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || typeof data.seed !== 'number') return null;
    return data;
  } catch (err) {
    console.warn('存档损坏，已忽略：', err);
    return null;
  }
}

/**
 * 清除存档（重置世界）。
 */
export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch (err) {
    console.warn('清除存档失败：', err);
  }
}

/** 是否存在可恢复存档。 */
export function hasSave() {
  return loadGame() !== null;
}
