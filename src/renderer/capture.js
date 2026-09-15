// 快速收藏窗口逻辑
const $ = (sel) => document.querySelector(sel);
const f = {
  title: $('#f-title'),
  source: $('#f-source'),
  tags: $('#f-tags'),
  url: $('#f-url'),
  conversation: $('#f-conversation'),
  task: $('#f-task'),
  content: $('#f-content'),
  status: $('#status'),
};

let limitHours = 5;
window.api.getSettings().then((st) => {
  limitHours = Number(st.limitHours) || 5;
  $('#limit-hours').textContent = limitHours;
});

window.api.onCapturePrefill((prefill) => {
  f.task.checked = false;
  f.content.value = prefill.content || '';
  f.url.value = prefill.url || '';
  f.conversation.value = prefill.conversation || '';
  f.source.value = prefill.source || 'other';
  f.title.value = '';
  f.tags.value = '';

  const grant = $('#btn-grant');
  grant.classList.toggle('hidden', !prefill.needsAccessibility);
  if (prefill.needsAccessibility) {
    f.status.textContent = `来自 ${prefill.app}，读取对话标题需要「辅助功能」权限`;
  } else if (prefill.url) {
    f.status.textContent = `来自 ${safeHost(prefill.url)}`;
  } else if (prefill.app && prefill.source !== 'other') {
    f.status.textContent = `来自 ${prefill.app}`;
  } else if (prefill.content) {
    f.status.textContent = '已读取剪贴板内容';
  } else {
    f.status.textContent = '剪贴板为空';
  }
  // 有内容时光标落在标题，没内容时落在正文
  (prefill.content ? f.title : f.content).focus();
});

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '浏览器';
  }
}

async function save() {
  const content = f.content.value.trim();
  if (!content) {
    f.status.textContent = '内容不能为空';
    f.content.focus();
    return;
  }
  $('#btn-save').disabled = true;
  const saved = await window.api.saveNote({
    title: f.title.value,
    source: f.source.value,
    tags: f.tags.value,
    url: f.url.value.trim(),
    conversation: f.conversation.value.trim(),
    content,
    ...(f.task.checked
      ? { kind: 'task', status: 'active', resumeAt: new Date(Date.now() + limitHours * 3600 * 1000).toISOString() }
      : {}),
  });
  await window.api.captureSaved(saved);
}

$('#btn-save').addEventListener('click', save);
$('#btn-cancel').addEventListener('click', () => window.api.closeCapture());
$('#btn-grant').addEventListener('click', () => window.api.openAccessibilitySettings());

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
  if (e.key === 'Escape') { e.preventDefault(); window.api.closeCapture(); }
});
