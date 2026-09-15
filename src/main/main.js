const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  clipboard,
  dialog,
  shell,
  Notification,
  Menu,
  nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const { NoteStore, TASK_TEMPLATE } = require('./store');
const { getFrontContext } = require('./browser');
const { notesToDocx } = require('./docx-export');

let mainWindow = null;
let captureWindow = null;
let store = null;
let watcher = null;
let currentSettings = settings.load();
const reminderTimers = new Map(); // 任务 id -> setTimeout 句柄

const PRELOAD = path.join(__dirname, '..', 'preload.js');
const RENDERER = path.join(__dirname, '..', 'renderer');

// ---------- 窗口 ----------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    title: 'AI Notes',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f7',
    webPreferences: {
      preload: PRELOAD,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(RENDERER, 'index.html'));
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.on('focus', () => mainWindow.webContents.send('notes-changed'));
}

function showMainWindow() {
  if (!mainWindow) createMainWindow();
  else mainWindow.show();
  mainWindow.focus();
}

async function openCaptureWindow() {
  // 在把焦点抢过来之前，先读前台应用（Claude / ChatGPT / 浏览器）信息和剪贴板
  let ctx = await getFrontContext();
  // 从本应用自己的窗口触发时，前台就是 AI Notes，没有可读的上下文
  if (ctx.app && (ctx.app === app.name || ctx.app === 'Electron' || ctx.app === 'AI Notes')) {
    ctx = { app: '', source: '', url: '', conversation: '', needsAccessibility: false };
  }
  const raw = clipboard.readText();
  const text = typeof raw === 'string' ? raw : ''; // 某些受限环境下会返回非字符串
  const prefill = {
    content: text,
    url: ctx.url,
    conversation: ctx.conversation,
    app: ctx.app,
    source: ctx.source || 'other',
    needsAccessibility: ctx.needsAccessibility,
  };

  if (captureWindow) {
    captureWindow.webContents.send('capture-prefill', prefill);
    captureWindow.show();
    captureWindow.focus();
    return;
  }

  captureWindow = new BrowserWindow({
    width: 560,
    height: 600,
    minWidth: 420,
    minHeight: 420,
    title: '快速收藏',
    show: false,
    alwaysOnTop: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f7',
    webPreferences: {
      preload: PRELOAD,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  captureWindow.loadFile(path.join(RENDERER, 'capture.html'));
  captureWindow.once('ready-to-show', () => {
    captureWindow.webContents.send('capture-prefill', prefill);
    captureWindow.show();
    captureWindow.focus();
  });
  captureWindow.on('closed', () => (captureWindow = null));
}

// ---------- 快捷键 ----------
function registerShortcut(accelerator) {
  globalShortcut.unregisterAll();
  if (!accelerator) return true;
  try {
    return globalShortcut.register(accelerator, () => openCaptureWindow());
  } catch (err) {
    console.error('注册快捷键失败', err);
    return false;
  }
}

// ---------- 目录监听（外部编辑时自动刷新） ----------
function watchNotesDir() {
  if (watcher) watcher.close();
  let timer = null;
  try {
    watcher = fs.watch(store.dir, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (mainWindow) mainWindow.webContents.send('notes-changed');
      }, 300);
    });
  } catch (err) {
    console.error('无法监听目录', err);
  }
}

function notifyChanged() {
  if (mainWindow) mainWindow.webContents.send('notes-changed');
  scheduleReminders();
}

// ---------- 任务：限额恢复提醒 ----------
function scheduleReminders() {
  for (const t of reminderTimers.values()) clearTimeout(t);
  reminderTimers.clear();
  for (const n of store.list()) {
    if (n.kind !== 'task' || n.status !== 'active' || !n.resumeAt) continue;
    const delay = new Date(n.resumeAt).getTime() - Date.now();
    if (delay <= 0) continue; // 已到点的在界面里显示"可以继续了"
    reminderTimers.set(n.id, setTimeout(() => notifyResume(n.id), Math.min(delay, 2 ** 31 - 1)));
  }
}

function notifyResume(id) {
  reminderTimers.delete(id);
  const n = store.list().find((x) => x.id === id);
  if (!n || n.status !== 'active' || !Notification.isSupported()) return;
  const notif = new Notification({ title: '限额应该恢复了，可以继续工作', body: n.title });
  notif.on('click', () => {
    showMainWindow();
    mainWindow.webContents.send('select-note', id);
  });
  notif.show();
}

// 启动时：有已到点但仍"进行中"的任务，提醒一次
function notifyOverdueOnStartup() {
  const due = store.list().filter((n) => n.kind === 'task' && n.status === 'active' && n.resumeAt && new Date(n.resumeAt) <= new Date());
  if (due.length === 0 || !Notification.isSupported()) return;
  const notif = new Notification({
    title: due.length === 1 ? '有一个任务可以继续了' : `有 ${due.length} 个任务可以继续了`,
    body: due.map((n) => n.title).join('、'),
    silent: true,
  });
  notif.on('click', () => {
    showMainWindow();
    mainWindow.webContents.send('select-note', due[0].id);
  });
  notif.show();
}

// 生成贴给 GPT 的"接续提示词"
function buildResumePrompt(n) {
  const lines = [
    '我们之前的对话因为使用限额中断了。下面是当时的进度记录，请先完整读一遍，然后直接从「下一步」继续，不要重复已完成的部分；如果记录里缺少你需要的信息，先问我。',
    '',
    `# ${n.title}`,
  ];
  if (n.conversation) lines.push(`（原对话：${n.conversation}）`);
  lines.push('', String(n.content || '').trim(), '');
  return lines.join('\n');
}

// ---------- 首次运行的欢迎笔记 ----------
function ensureWelcomeNote() {
  if (store.list().length > 0) return;
  store.save({
    title: '欢迎使用 AI Notes',
    source: 'claude',
    tags: ['使用说明'],
    url: '',
    content: [
      '这是一个本地笔记工具，用来记录你和 Claude、GPT 等 AI 对话中有价值的内容。',
      '',
      '## 怎么用',
      '',
      '1. 在 Claude 或 ChatGPT 应用里选中一段回答，按 **⌘C** 复制，然后按全局快捷键 **⌘⇧S**，会弹出「快速收藏」窗口。',
      '2. 窗口里会自动填好内容、来源（按前台应用识别 Claude / GPT）和对话标题，你补个标题、加几个标签，按 **⌘↩** 保存。',
      '3. 如果是在浏览器里用网页版，还会自动带上对话链接。桌面版没有公开链接，可以在应用里「分享 → 复制链接」后手动粘到「链接」栏。',
      '4. 所有笔记都以 Markdown 文件保存在 `~/Documents/AI Notes`，可以用 Obsidian、Typora 等任何工具打开；按 **⌘⇧E** 可导出为 Word。',
      '',
      '## 被限额打断了怎么办',
      '',
      '按 **⌘⇧T** 新建一条「任务记录」，或在快速收藏时勾选「记录为进行中的任务」。写下目标、已完成、下一步，点「+5h」标记限额恢复时间。',
      '到点后系统会通知你；打开这条记录，点「复制接续提示」，粘进新对话，GPT 就能从中断处继续。',
      '',
      '## 支持 Markdown 和代码高亮',
      '',
      '```python',
      'def hello(name: str) -> str:',
      '    return f"Hello, {name}!"',
      '```',
      '',
      '> 提示：自动读取对话标题需要在「系统设置 → 隐私与安全性 → 辅助功能」里允许 AI Notes；读取浏览器链接则需要允许「自动化」。第一次用时系统会弹窗询问，拒绝也不影响其他功能。',
    ].join('\n'),
  });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('notes:list', () => store.list());
  ipcMain.handle('notes:save', (_e, note) => {
    const saved = store.save(note);
    notifyChanged();
    return saved;
  });
  ipcMain.handle('notes:delete', async (_e, id) => {
    const ok = await store.remove(id);
    notifyChanged();
    return ok;
  });
  ipcMain.handle('notes:reveal', (_e, id) => store.revealInFinder(id));
  ipcMain.handle('notes:openDir', () => shell.openPath(store.dir));

  ipcMain.handle('settings:get', () => currentSettings);
  ipcMain.handle('settings:set', (_e, partial) => {
    const prev = currentSettings;
    currentSettings = settings.save(partial);
    if (partial.notesDir && partial.notesDir !== prev.notesDir) {
      store.setDir(currentSettings.notesDir);
      watchNotesDir();
      notifyChanged();
    }
    if (partial.shortcut !== undefined && partial.shortcut !== prev.shortcut) {
      if (!registerShortcut(currentSettings.shortcut)) {
        currentSettings = settings.save({ shortcut: prev.shortcut });
        registerShortcut(prev.shortcut);
        return { ...currentSettings, error: '快捷键无效或已被占用' };
      }
    }
    return currentSettings;
  });
  ipcMain.handle('settings:chooseDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择笔记保存文件夹',
      defaultPath: currentSettings.notesDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('capture:open', () => openCaptureWindow());
  ipcMain.handle('capture:close', () => captureWindow && captureWindow.close());
  ipcMain.handle('capture:saved', (_e, note) => {
    if (captureWindow) captureWindow.close();
    if (Notification.isSupported()) {
      new Notification({ title: '已收藏', body: note.title, silent: true }).show();
    }
  });

  ipcMain.handle('task:template', () => TASK_TEMPLATE);
  ipcMain.handle('task:copyResumePrompt', (_e, id) => {
    const n = store.list().find((x) => x.id === id);
    if (!n) return false;
    clipboard.writeText(buildResumePrompt(n));
    return true;
  });

  // 导出 Word：ids 为要导出的笔记 id 列表（一条或多条合成一个文档）
  ipcMain.handle('export:docx', async (_e, ids) => {
    const all = store.list();
    const notes = ids.map((id) => all.find((n) => n.id === id)).filter(Boolean);
    if (notes.length === 0) return { ok: false, error: '没有可导出的笔记' };
    const defaultName = notes.length === 1 ? `${safeFileName(notes[0].title)}.docx` : `AI Notes 导出 ${new Date().toISOString().slice(0, 10)}.docx`;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出为 Word 文档',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'Word 文档', extensions: ['docx'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const buf = await notesToDocx(notes);
      fs.writeFileSync(res.filePath, buf);
      shell.showItemInFolder(res.filePath);
      return { ok: true, path: res.filePath, count: notes.length };
    } catch (err) {
      console.error('导出失败', err);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('app:showMain', () => showMainWindow());
  ipcMain.handle('app:openAccessibilitySettings', () =>
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  );
}

function safeFileName(name) {
  return String(name || '未命名').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '未命名';
}

// ---------- 菜单 ----------
function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 AI Notes' },
        { type: 'separator' },
        { label: '设置…', accelerator: 'Cmd+,', click: () => mainWindow && mainWindow.webContents.send('open-settings') },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 AI Notes' },
      ],
    },
    {
      label: '文件',
      submenu: [
        { label: '新建笔记', accelerator: 'Cmd+N', click: () => { showMainWindow(); mainWindow.webContents.send('new-note'); } },
        { label: '新建任务记录（限额中断时用）', accelerator: 'Cmd+Shift+T', click: () => { showMainWindow(); mainWindow.webContents.send('new-task'); } },
        { label: '快速收藏（从剪贴板）', accelerator: 'Cmd+Shift+N', click: () => openCaptureWindow() },
        { type: 'separator' },
        { label: '导出当前笔记为 Word…', accelerator: 'Cmd+Shift+E', click: () => mainWindow && mainWindow.webContents.send('export-current') },
        { label: '导出当前列表为 Word…', click: () => mainWindow && mainWindow.webContents.send('export-list') },
        { type: 'separator' },
        { label: '在 Finder 中打开笔记文件夹', click: () => shell.openPath(store.dir) },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '搜索', accelerator: 'Cmd+F', click: () => mainWindow && mainWindow.webContents.send('focus-search') },
        { label: '切换编辑 / 预览', accelerator: 'Cmd+E', click: () => mainWindow && mainWindow.webContents.send('toggle-preview') },
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    { label: '窗口', role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  // 开发/测试用：AI_NOTES_DIR 环境变量可临时覆盖笔记目录（不写入设置）
  if (process.env.AI_NOTES_DIR) currentSettings = { ...currentSettings, notesDir: process.env.AI_NOTES_DIR };
  store = new NoteStore(currentSettings.notesDir);
  ensureWelcomeNote();
  registerIpc();
  buildMenu();
  createMainWindow();
  watchNotesDir();
  scheduleReminders();
  setTimeout(notifyOverdueOnStartup, 2000);
  if (!registerShortcut(currentSettings.shortcut)) {
    console.error('全局快捷键注册失败:', currentSettings.shortcut);
  }
  if (process.env.AI_NOTES_SCREENSHOT) devScreenshots(process.env.AI_NOTES_SCREENSHOT);
});

// 开发用：自动截图主窗口和收藏窗口后退出
async function devScreenshots(outDir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1500);
  fs.writeFileSync(path.join(outDir, 'main.png'), (await mainWindow.webContents.capturePage()).toPNG());
  clipboard.writeText('这是从剪贴板读到的示例内容：\n\n```js\nconsole.log("hi")\n```');
  await openCaptureWindow();
  await wait(1200);
  fs.writeFileSync(path.join(outDir, 'capture.png'), (await captureWindow.webContents.capturePage()).toPNG());
  app.quit();
}

app.on('activate', () => showMainWindow());

// macOS 习惯：关闭窗口不退出，保持快捷键可用
app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (watcher) watcher.close();
});
