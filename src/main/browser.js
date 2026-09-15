// 读取"按下快捷键那一刻"前台应用的上下文：来源、对话标题、链接。
// - Claude / ChatGPT 桌面版：来源按应用名识别，对话标题取前台窗口标题（需要「辅助功能」权限）
// - Safari / Chrome 系浏览器：取当前标签页 URL 与标题（需要「自动化」权限）
const { execFile } = require('child_process');

const CHROMIUM_APPS = ['Google Chrome', 'Arc', 'Brave Browser', 'Microsoft Edge', 'Chromium', 'Vivaldi', 'Opera'];

function osascript(script, timeout = 1500) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: '', err: String(stderr || err.message || '') });
      else resolve({ ok: true, out: String(stdout).trim(), err: '' });
    });
  });
}

async function frontmostAppName() {
  const r = await osascript('tell application "System Events" to get name of first application process whose frontmost is true');
  return r.ok ? r.out : '';
}

// 读窗口标题需要辅助功能权限；失败时返回 needsAccessibility 提示上层
async function frontWindowTitle(appName) {
  const r = await osascript(`tell application "System Events" to tell process "${appName}" to get name of front window`);
  if (r.ok) return { title: r.out, needsAccessibility: false };
  const denied = /-1728|-25211|辅助访问|assistive access|not allowed/i.test(r.err);
  return { title: '', needsAccessibility: denied };
}

function sourceFromApp(appName) {
  const a = String(appName || '').toLowerCase();
  if (a.includes('claude')) return 'claude';
  if (a.includes('chatgpt') || a.includes('openai')) return 'gpt';
  if (a.includes('gemini')) return 'gemini';
  return '';
}

function detectSource(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('claude.ai') || u.includes('anthropic.com')) return 'claude';
  if (u.includes('chatgpt.com') || u.includes('openai.com')) return 'gpt';
  if (u.includes('gemini.google')) return 'gemini';
  return '';
}

/** 返回 { app, source, url, conversation, needsAccessibility } */
async function getFrontContext() {
  const empty = { app: '', source: '', url: '', conversation: '', needsAccessibility: false };
  if (process.platform !== 'darwin') return empty;
  const app = await frontmostAppName();
  if (!app) return empty;

  // 浏览器：读标签页
  let tabScript = null;
  if (app === 'Safari') {
    tabScript = 'tell application "Safari" to return (URL of current tab of front window) & "\n" & (name of current tab of front window)';
  } else if (CHROMIUM_APPS.includes(app)) {
    tabScript = `tell application "${app}" to return (URL of active tab of front window) & "\n" & (title of active tab of front window)`;
  }
  if (tabScript) {
    const r = await osascript(tabScript);
    const [url = '', title = ''] = r.out.split('\n');
    return { app, source: detectSource(url), url: url.trim(), conversation: cleanTitle(title, app), needsAccessibility: false };
  }

  // 桌面应用（Claude / ChatGPT 等）：按应用名识别来源，窗口标题当作对话标题
  const source = sourceFromApp(app);
  const { title, needsAccessibility } = await frontWindowTitle(app);
  return { app, source, url: '', conversation: cleanTitle(title, app), needsAccessibility };
}

// 去掉窗口标题里的应用名后缀，如 "xxx - ChatGPT" / "xxx — Claude"
function cleanTitle(title, app) {
  let t = String(title || '').trim();
  if (!t) return '';
  t = t.replace(new RegExp(`\\s*[-—–|·]\\s*${escapeRe(app)}\\s*$`, 'i'), '');
  if (t.toLowerCase() === app.toLowerCase()) return ''; // 只有应用名，没有对话标题
  return t;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { getFrontContext, detectSource, sourceFromApp };
