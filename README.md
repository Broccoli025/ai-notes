# AI Notes

一个本地 macOS 小工具，用来记录和 Claude、GPT 等 AI 对话中值得留下的内容。所有笔记都是普通的 Markdown 文件，随时可以用别的工具打开。

## 功能

- **快速收藏**：在 Claude、ChatGPT 桌面应用（或网页版）里复制一段回答，按全局快捷键 `⌘⇧S`，弹窗里自动填好内容，并按前台应用识别来源（Claude / GPT）、读取对话标题；网页版还会带上对话链接。补个标题和标签按 `⌘↩` 保存。
- **标签与来源**：左侧按来源、标签筛选；顶部搜索标题、正文、标签、链接。
- **两种编辑方式**：「Markdown」标签页写源码；「文档」标签页像 Word 一样直接在排版后的文档上改字，带粗体、斜体、标题级别、列表、引用、代码、链接等工具条。两边随时用 `⌘E` 切换，内容始终以 Markdown 存盘。
- **任务记录（应对使用限额）**：GPT 的 5 小时限额打断工作时，按 `⌘⇧T` 新建一条任务记录（或快速收藏时勾选「记录为进行中的任务」），按模板写下目标、已完成、下一步和关键上下文，点「+5h」标记恢复时间。到点系统通知；打开记录点「复制接续提示」，粘进新对话，GPT 就从中断处继续。侧栏「进行中 / 已完成」可以看所有任务，限额时长可在设置里改。
- **导出 Word**：当前笔记 `⌘⇧E` 一键导出 .docx；「文件 → 导出当前列表为 Word」把筛选出的多条笔记合成一个文档。按中文排版惯例设置：A4 页边距、正文宋体配 Times New Roman、标题黑体、1.5 倍行距；代码块是带底色的完整区块，表格有表头底色和对齐，列表紧凑不留空行。不依赖 pandoc。
- **纯文件存储**：每条笔记一个 `.md` 文件（含 YAML frontmatter），默认在 `~/Documents/AI Notes`，可在设置里改到 iCloud 或 Obsidian 库。外部修改会自动刷新。
- **删除进废纸篓**，可恢复。

## 运行

```bash
npm install
npm start
```

## 打包成 .app

```bash
npm run dist
```

生成的应用在 `release/mac-arm64/AI Notes.app`，拖进「应用程序」即可。未签名，首次打开若被拦截，在「系统设置 → 隐私与安全性」里点「仍要打开」。

## 首次使用注意

- 读取 Claude / ChatGPT 桌面应用的对话标题需要「辅助功能」权限：系统设置 → 隐私与安全性 → 辅助功能，把 AI Notes 加进去。收藏窗口里点「去授权」会直接跳到该页面。没有权限时来源识别仍然正常，只是对话标题要手填。
- 桌面版应用没有公开的对话链接，需要的话在应用里「分享 → 复制链接」再粘到「链接」栏。网页版在 Safari / Chrome 中会自动读取链接，第一次会弹出「AI Notes 想要控制 Safari/Chrome」的授权。
- 快捷键可在设置（`⌘,`）里修改，格式如 `CommandOrControl+Shift+S`。

## 笔记文件格式

```markdown
---
id: a1b2c3d4e5f6
title: pandas groupby 之后如何保留其他列
source: gpt
tags:
  - python
  - pandas
url: https://chatgpt.com/c/...
conversation: 单细胞数据分组统计
kind: task            # 任务记录才有以下三项
status: active        # active | done
resumeAt: '2026-09-15T14:00:00.000Z'
created: '2026-09-10T02:10:00.000Z'
updated: '2026-09-12T09:30:00.000Z'
---

正文（Markdown）
```

## 目录结构

```
src/main/main.js         主进程：窗口、全局快捷键、菜单、IPC
src/main/store.js        Markdown 文件读写
src/main/docx-export.js  Markdown → Word 转换
src/main/browser.js      识别前台应用（Claude / ChatGPT / 浏览器），读取对话标题或链接
src/main/settings.js     设置持久化
src/preload.js           渲染进程可用的安全 API、Markdown 渲染与回写
src/renderer/            主窗口与快速收藏窗口的界面（含文档模式的富文本编辑）
```
