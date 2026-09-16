// 预加载脚本：在隔离环境中向页面暴露安全的 API。
const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const hljs = require('highlight.js');
const createDOMPurify = require('dompurify');
const TurndownService = require('turndown');

const DOMPurify = createDOMPurify(window);

const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  const language = lang && hljs.getLanguage(lang) ? lang : null;
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value;
  const cls = language ? ` class="hljs language-${language}"` : ' class="hljs"';
  const label = language ? `<span class="code-lang">${language}</span>` : '';
  return `<div class="code-block">${label}<pre><code${cls}>${highlighted}</code></pre></div>`;
};
marked.setOptions({ renderer, gfm: true, breaks: true });

function renderMarkdown(text) {
  const html = marked.parse(String(text || ''));
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

// 富文本编辑区改回 Markdown
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  strongDelimiter: '**',
  emDelimiter: '*',
  hr: '---',
});
// turndown 后加入的规则优先级更高，所以通用的 span 规则必须先加，特例后加。
// execCommand 会留下无意义的 span 包裹
turndown.addRule('bareSpan', { filter: 'span', replacement: (content) => content });
// 高亮只是阅读时的视觉标记，不写进 Markdown
turndown.addRule('highlight', { filter: (n) => n.nodeName === 'SPAN' && n.style && n.style.backgroundColor, replacement: (content) => content });
// 代码块上角的语言标签只是界面提示，不能被当成正文带回 Markdown
turndown.addRule('codeLangLabel', { filter: (n) => n.nodeName === 'SPAN' && n.classList.contains('code-lang'), replacement: () => '' });
// 删除线
turndown.addRule('strikethrough', { filter: ['del', 's', 'strike'], replacement: (content) => '~~' + content + '~~' });

function htmlToMarkdown(html) {
  return turndown
    .turndown(String(html || ''))
    // turndown 会把列表符号补成固定宽度（"-   项"），统一收回成一个空格，
    // 否则每次往返都会改写文件。行首缩进保留，嵌套层级不受影响。
    .replace(/^([ \t]*)([-*+]|\d+\.)[ \t]{2,}/gm, '$1$2 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function on(channel, handler) {
  const wrapped = (_event, ...args) => handler(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('api', {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  saveNote: (note) => ipcRenderer.invoke('notes:save', note),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),
  revealNote: (id) => ipcRenderer.invoke('notes:reveal', id),
  openNotesDir: () => ipcRenderer.invoke('notes:openDir'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  chooseDir: () => ipcRenderer.invoke('settings:chooseDir'),

  openCapture: () => ipcRenderer.invoke('capture:open'),
  closeCapture: () => ipcRenderer.invoke('capture:close'),
  captureSaved: (note) => ipcRenderer.invoke('capture:saved', note),
  showMain: () => ipcRenderer.invoke('app:showMain'),
  openAccessibilitySettings: () => ipcRenderer.invoke('app:openAccessibilitySettings'),

  exportDocx: (ids) => ipcRenderer.invoke('export:docx', ids),
  taskTemplate: () => ipcRenderer.invoke('task:template'),
  copyResumePrompt: (id) => ipcRenderer.invoke('task:copyResumePrompt', id),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  renderMarkdown,
  htmlToMarkdown,

  onNotesChanged: (fn) => on('notes-changed', fn),
  onNewNote: (fn) => on('new-note', fn),
  onFocusSearch: (fn) => on('focus-search', fn),
  onTogglePreview: (fn) => on('toggle-preview', fn),
  onOpenSettings: (fn) => on('open-settings', fn),
  onCapturePrefill: (fn) => on('capture-prefill', fn),
  onExportCurrent: (fn) => on('export-current', fn),
  onExportList: (fn) => on('export-list', fn),
  onNewTask: (fn) => on('new-task', fn),
  onSelectNote: (fn) => on('select-note', fn),
});
