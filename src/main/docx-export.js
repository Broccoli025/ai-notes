// Markdown → Word (.docx) 转换。基于 marked 的词法分析结果构建 docx 文档，无需外部依赖（不需要 pandoc）。
const { marked } = require('marked');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  ExternalHyperlink,
  LevelFormat,
  AlignmentType,
  PageBreak,
} = require('docx');

const FONT_BODY = 'Songti SC'; // 宋体；Word 找不到时会自动回退
const FONT_LATIN = 'Calibri';
const FONT_MONO = 'Menlo';
const CODE_BG = 'F2F2F2';
const QUOTE_COLOR = '595959';
const MAX_ORDERED_LISTS = 200;

const SOURCE_LABEL = { claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', other: '其他' };

// ---------- 对外接口 ----------

/** 把一条或多条笔记导出为一个 docx Buffer。 */
async function notesToDocx(notes, { includeMeta = true } = {}) {
  const ctx = { orderedListCount: 0 };
  const children = [];

  notes.forEach((note, idx) => {
    if (idx > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(
      new Paragraph({
        heading: notes.length > 1 ? HeadingLevel.HEADING_1 : HeadingLevel.TITLE,
        children: [new TextRun({ text: note.title || '未命名' })],
      })
    );
    if (includeMeta) children.push(metaParagraph(note));
    children.push(...markdownToBlocks(note.content || '', ctx));
  });

  const doc = new Document({
    creator: 'AI Notes',
    title: notes.length === 1 ? notes[0].title : 'AI Notes 导出',
    styles: {
      default: {
        document: {
          run: { font: { ascii: FONT_LATIN, hAnsi: FONT_LATIN, eastAsia: FONT_BODY }, size: 22 }, // 11pt
          paragraph: { spacing: { after: 120, line: 300 } },
        },
        // 覆盖 Word 内置标题样式，导出后在 Word 里仍可用「样式」面板统一调整
        title: { run: { size: 36, bold: true, color: '1D1D1F' }, paragraph: { spacing: { before: 0, after: 240 } } },
        heading1: { run: { size: 32, bold: true, color: '1D1D1F' }, paragraph: { spacing: { before: 360, after: 160 } } },
        heading2: { run: { size: 28, bold: true, color: '1D1D1F' }, paragraph: { spacing: { before: 300, after: 120 } } },
        heading3: { run: { size: 24, bold: true, color: '1D1D1F' }, paragraph: { spacing: { before: 240, after: 100 } } },
        heading4: { run: { size: 22, bold: true, color: '1D1D1F' }, paragraph: { spacing: { before: 200, after: 80 } } },
      },
      paragraphStyles: [
        {
          id: 'SourceCode',
          name: 'Source Code',
          basedOn: 'Normal',
          next: 'SourceCode',
          quickFormat: true,
          run: { font: { ascii: FONT_MONO, hAnsi: FONT_MONO, eastAsia: FONT_MONO }, size: 18 },
          paragraph: {
            shading: { type: ShadingType.CLEAR, fill: CODE_BG, color: 'auto' },
            spacing: { before: 0, after: 0, line: 276 },
            indent: { left: 200, right: 200 },
          },
        },
        {
          id: 'Quote',
          name: 'Quote',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { color: QUOTE_COLOR },
          paragraph: {
            indent: { left: 480 },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'BBBBBB', space: 12 } },
          },
        },
      ],
    },
    numbering: { config: numberingConfig(ctx) },
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(doc);
}

function metaParagraph(note) {
  const parts = [];
  parts.push(new TextRun({ text: `来源：${SOURCE_LABEL[note.source] || note.source || '其他'}`, color: QUOTE_COLOR, size: 18 }));
  if (note.tags && note.tags.length) {
    parts.push(new TextRun({ text: `　标签：${note.tags.join('、')}`, color: QUOTE_COLOR, size: 18 }));
  }
  if (note.conversation) {
    parts.push(new TextRun({ text: `　对话：${note.conversation}`, color: QUOTE_COLOR, size: 18 }));
  }
  if (note.kind === 'task') {
    parts.push(new TextRun({ text: `　任务：${note.status === 'done' ? '已完成' : '进行中'}`, color: QUOTE_COLOR, size: 18 }));
  }
  if (note.created) {
    parts.push(new TextRun({ text: `　${new Date(note.created).toLocaleDateString('zh-CN')}`, color: QUOTE_COLOR, size: 18 }));
  }
  if (note.url) {
    parts.push(new TextRun({ text: '　', size: 18 }));
    parts.push(
      new ExternalHyperlink({
        link: note.url,
        children: [new TextRun({ text: '原始对话', style: 'Hyperlink', size: 18 })],
      })
    );
  }
  return new Paragraph({
    children: parts,
    spacing: { after: 240 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD', space: 6 } },
  });
}

// 有序列表每个实例独立编号：预先声明足够多的 reference。
function numberingConfig() {
  const config = [
    {
      reference: 'bullets',
      levels: [0, 1, 2, 3].map((level) => ({
        level,
        format: LevelFormat.BULLET,
        text: ['•', '◦', '▪', '•'][level],
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
      })),
    },
  ];
  for (let i = 0; i < MAX_ORDERED_LISTS; i++) {
    config.push({
      reference: `ordered-${i}`,
      levels: [0, 1, 2, 3].map((level) => ({
        level,
        format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN, LevelFormat.DECIMAL][level],
        text: `%${level + 1}.`,
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
      })),
    });
  }
  return config;
}

// ---------- 块级元素 ----------

function markdownToBlocks(markdown, ctx) {
  const tokens = marked.lexer(String(markdown || ''), { gfm: true });
  return tokensToBlocks(tokens, ctx, {});
}

/** opts: { indent, quote, numbering } 会向下传递 */
function tokensToBlocks(tokens, ctx, opts) {
  const out = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'heading':
        out.push(
          new Paragraph({
            heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][
              Math.min(tok.depth, 6) - 1
            ],
            children: inlineRuns(tok.tokens || [], {}),
          })
        );
        break;
      case 'paragraph':
      case 'text':
        out.push(paragraph(inlineRuns(tok.tokens || [{ type: 'text', text: tok.text }], {}), opts));
        break;
      case 'code':
        out.push(...codeBlock(tok.text, opts));
        break;
      case 'blockquote':
        out.push(...tokensToBlocks(tok.tokens || [], ctx, { ...opts, quote: true, indent: (opts.indent || 0) + 1 }));
        break;
      case 'list':
        out.push(...listBlocks(tok, ctx, opts));
        break;
      case 'table':
        out.push(tableBlock(tok), new Paragraph({ text: '' }));
        break;
      case 'hr':
        out.push(
          new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } },
            spacing: { before: 120, after: 240 },
          })
        );
        break;
      case 'html':
        out.push(paragraph([new TextRun({ text: stripHtml(tok.text) })], opts));
        break;
      default:
        if (tok.tokens) out.push(...tokensToBlocks(tok.tokens, ctx, opts));
        else if (tok.text) out.push(paragraph([new TextRun({ text: tok.text })], opts));
    }
  }
  return out;
}

function paragraph(children, opts) {
  const props = { children };
  if (opts.numbering) props.numbering = opts.numbering;
  else if (opts.indent) props.indent = { left: 720 * opts.indent };
  if (opts.quote) props.style = 'Quote';
  return new Paragraph(props);
}

function codeBlock(text, opts) {
  const lines = String(text).replace(/\n$/, '').split('\n');
  return lines.map(
    (line, i) =>
      new Paragraph({
        style: 'SourceCode',
        children: [new TextRun({ text: line || ' ' })],
        indent: opts.indent ? { left: 720 * opts.indent + 200, right: 200 } : undefined,
        spacing: { before: i === 0 ? 120 : 0, after: i === lines.length - 1 ? 160 : 0 },
        keepNext: i < lines.length - 1,
      })
  );
}

function listBlocks(list, ctx, opts) {
  const level = opts.listLevel || 0;
  let reference = 'bullets';
  if (list.ordered) {
    reference = `ordered-${Math.min(ctx.orderedListCount, MAX_ORDERED_LISTS - 1)}`;
    ctx.orderedListCount += 1;
  }
  const out = [];
  for (const item of list.items) {
    const numbering = { reference, level: Math.min(level, 3) };
    const inner = item.tokens || [];
    // 第一段带项目符号，其余段落 / 子列表跟随
    let first = true;
    for (const tok of inner) {
      if (tok.type === 'list') {
        out.push(...listBlocks(tok, ctx, { ...opts, listLevel: level + 1, numbering: undefined }));
      } else if (first && (tok.type === 'text' || tok.type === 'paragraph')) {
        const runs = inlineRuns(tok.tokens || [{ type: 'text', text: tok.text }], {});
        if (item.task) runs.unshift(new TextRun({ text: item.checked ? '☑ ' : '☐ ' }));
        out.push(paragraph(runs, { ...opts, numbering, indent: undefined }));
        first = false;
      } else {
        out.push(...tokensToBlocks([tok], ctx, { ...opts, numbering: undefined, indent: level + 1 }));
      }
    }
    if (first) out.push(paragraph([new TextRun({ text: '' })], { ...opts, numbering }));
  }
  return out;
}

function tableBlock(tok) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (cellTok, isHeader) =>
    new TableCell({
      borders,
      shading: isHeader ? { type: ShadingType.CLEAR, fill: 'EFEFEF', color: 'auto' } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [
        new Paragraph({
          children: inlineRuns(cellTok.tokens || [{ type: 'text', text: cellTok.text }], isHeader ? { bold: true } : {}),
          spacing: { after: 0 },
        }),
      ],
    });
  const rows = [new TableRow({ tableHeader: true, children: tok.header.map((c) => cell(c, true)) })];
  for (const r of tok.rows) rows.push(new TableRow({ children: r.map((c) => cell(c, false)) }));
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

// ---------- 行内元素 ----------

function inlineRuns(tokens, style) {
  const runs = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text':
      case 'escape':
        if (tok.tokens && tok.tokens.length) runs.push(...inlineRuns(tok.tokens, style));
        else runs.push(new TextRun({ text: decode(tok.text), ...style }));
        break;
      case 'strong':
        runs.push(...inlineRuns(tok.tokens || [], { ...style, bold: true }));
        break;
      case 'em':
        runs.push(...inlineRuns(tok.tokens || [], { ...style, italics: true }));
        break;
      case 'del':
        runs.push(...inlineRuns(tok.tokens || [], { ...style, strike: true }));
        break;
      case 'codespan':
        runs.push(
          new TextRun({
            text: decode(tok.text),
            font: FONT_MONO,
            size: 19,
            shading: { type: ShadingType.CLEAR, fill: CODE_BG, color: 'auto' },
            ...style,
          })
        );
        break;
      case 'link':
        runs.push(
          new ExternalHyperlink({
            link: tok.href,
            children: inlineRuns(tok.tokens || [{ type: 'text', text: tok.text }], { ...style, style: 'Hyperlink' }),
          })
        );
        break;
      case 'image':
        runs.push(new TextRun({ text: `[图片${tok.text ? '：' + tok.text : ''}]`, color: QUOTE_COLOR, ...style }));
        break;
      case 'br':
        runs.push(new TextRun({ text: '', break: 1 }));
        break;
      case 'html':
        runs.push(new TextRun({ text: stripHtml(tok.text), ...style }));
        break;
      default:
        if (tok.tokens) runs.push(...inlineRuns(tok.tokens, style));
        else if (tok.text) runs.push(new TextRun({ text: decode(tok.text), ...style }));
    }
  }
  return runs;
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(s) {
  return decode(String(s || '').replace(/<[^>]+>/g, ''));
}

module.exports = { notesToDocx };
