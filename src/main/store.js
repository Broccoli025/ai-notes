// 笔记存储层：每条笔记是一个带 YAML frontmatter 的 .md 文件。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const matter = require('gray-matter');
const { shell } = require('electron');

class NoteStore {
  constructor(dir) {
    this.setDir(dir);
  }

  setDir(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  // ---------- 读取 ----------
  listFiles() {
    return fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md') && !d.name.startsWith('.'))
      .map((d) => path.join(this.dir, d.name));
  }

  readFile(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = matter(raw);
    const fm = parsed.data || {};
    const stat = fs.statSync(file);
    const created = fm.created ? new Date(fm.created) : stat.birthtime;
    const updated = fm.updated ? new Date(fm.updated) : stat.mtime;
    return {
      id: String(fm.id || path.basename(file, '.md')),
      title: String(fm.title || path.basename(file, '.md')),
      source: normalizeSource(fm.source),
      tags: normalizeTags(fm.tags),
      url: fm.url ? String(fm.url) : '',
      conversation: fm.conversation ? String(fm.conversation) : '',
      kind: fm.kind === 'task' ? 'task' : 'note',
      status: fm.status === 'done' ? 'done' : 'active',
      resumeAt: normalizeDate(fm.resumeAt),
      created: created.toISOString(),
      updated: updated.toISOString(),
      content: parsed.content.replace(/^\n+/, ''),
      file,
    };
  }

  list() {
    const notes = [];
    for (const file of this.listFiles()) {
      try {
        notes.push(this.readFile(file));
      } catch (err) {
        console.error('无法读取笔记', file, err.message);
      }
    }
    notes.sort((a, b) => (a.updated < b.updated ? 1 : -1));
    return notes;
  }

  findFileById(id) {
    for (const file of this.listFiles()) {
      try {
        const { data } = matter(fs.readFileSync(file, 'utf8'));
        if (String(data.id) === String(id)) return file;
      } catch {
        /* 跳过损坏文件 */
      }
    }
    return null;
  }

  // ---------- 写入 ----------
  save(input) {
    const now = new Date().toISOString();
    const existingFile = input.id ? this.findFileById(input.id) : null;
    const existing = existingFile ? this.readFile(existingFile) : null;

    const note = {
      id: existing ? existing.id : input.id || newId(),
      title: (input.title || '').trim() || deriveTitle(input.content) || '未命名',
      source: normalizeSource(input.source),
      tags: normalizeTags(input.tags),
      url: (input.url || '').trim(),
      conversation: (input.conversation || '').trim(),
      // 未显式传 kind 时保留原有的任务属性，避免普通保存把任务降级成笔记
      kind: input.kind !== undefined ? (input.kind === 'task' ? 'task' : 'note') : existing ? existing.kind : 'note',
      status: input.status !== undefined ? (input.status === 'done' ? 'done' : 'active') : existing ? existing.status : 'active',
      resumeAt: input.resumeAt !== undefined ? normalizeDate(input.resumeAt) : existing ? existing.resumeAt : '',
      created: existing ? existing.created : input.created || now,
      updated: now,
      content: (input.content || '').replace(/\r\n/g, '\n'),
    };

    const targetFile = this.uniquePath(note, existingFile);
    const body = matter.stringify('\n' + note.content.replace(/\n*$/, '\n'), {
      id: note.id,
      title: note.title,
      source: note.source,
      tags: note.tags,
      url: note.url,
      conversation: note.conversation,
      ...(note.kind === 'task' ? { kind: 'task', status: note.status, resumeAt: note.resumeAt } : {}),
      created: note.created,
      updated: note.updated,
    });

    if (existingFile && existingFile !== targetFile) {
      fs.renameSync(existingFile, targetFile);
    }
    fs.writeFileSync(targetFile, body, 'utf8');
    return { ...note, file: targetFile };
  }

  // 文件名 = 标题 + 短 id，标题改动时重命名。
  uniquePath(note, currentFile) {
    const shortId = note.id.slice(0, 6);
    const slug = slugify(note.title) || 'note';
    const name = `${slug}-${shortId}.md`;
    const target = path.join(this.dir, name);
    if (currentFile && path.resolve(currentFile) === path.resolve(target)) return currentFile;
    return target;
  }

  async remove(id) {
    const file = this.findFileById(id);
    if (!file) return false;
    await shell.trashItem(file); // 移入废纸篓，可恢复
    return true;
  }

  revealInFinder(id) {
    const file = this.findFileById(id);
    if (file) shell.showItemInFolder(file);
  }
}

// ---------- 工具函数 ----------
function newId() {
  return crypto.randomBytes(6).toString('hex');
}

const SOURCES = ['claude', 'gpt', 'gemini', 'other'];
function normalizeSource(s) {
  const v = String(s || '').toLowerCase().trim();
  if (v.includes('claude')) return 'claude';
  if (v.includes('gpt') || v.includes('openai')) return 'gpt';
  if (v.includes('gemini')) return 'gemini';
  return SOURCES.includes(v) ? v : 'other';
}

function normalizeTags(tags) {
  const arr = Array.isArray(tags)
    ? tags
    : String(tags || '')
        .split(/[,，#\s]+/)
        .filter(Boolean);
  const seen = new Set();
  return arr
    .map((t) => String(t).trim())
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

function normalizeDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

// 任务笔记的默认模板
const TASK_TEMPLATE = [
  '## 目标',
  '',
  '',
  '## 已完成',
  '- ',
  '',
  '## 下一步',
  '- ',
  '',
  '## 关键上下文',
  '（把 GPT 继续工作需要的数据、代码片段、约定粘在这里）',
  '',
].join('\n');

function deriveTitle(content) {
  const line = String(content || '')
    .split('\n')
    .map((l) => l.replace(/^[#>\-*\s`]+/, '').trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 60) : '';
}

// 支持中文的文件名清洗：去掉文件系统不允许的字符。
function slugify(title) {
  return String(title)
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}

module.exports = { NoteStore, SOURCES, normalizeSource, normalizeTags, deriveTitle, TASK_TEMPLATE };
