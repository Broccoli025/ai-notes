// 应用设置：存储目录、全局快捷键等。保存在 Electron 的 userData 目录下。
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  notesDir: path.join(app.getPath('documents'), 'AI Notes'),
  shortcut: 'CommandOrControl+Shift+S',
  limitHours: 5, // GPT 等服务的使用限额时长（小时），用于"任务"的恢复提醒
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(partial) {
  const next = { ...load(), ...partial };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { load, save, DEFAULTS };
