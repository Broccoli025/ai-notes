// Markdown → Word (.docx) 转换。基于 marked 的词法分析结果构建 docx 文档，不依赖 pandoc。
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
  TableLayoutType,
  WidthType,
  BorderStyle,
  ShadingType,
  ExternalHyperlink,
  LevelFormat,
  AlignmentType,
  PageBreak,
  VerticalAlign,
  convertMillimetersToTwip,
} = require('docx');

// ---------- 排版常量 ----------
// 中文排版惯例：正文宋体，标题黑体，西文分别配 Times New Roman / Arial。
const FONT_BODY = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '宋体' };
const FONT_HEAD = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: '黑体' };
const FONT_MONO = { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: '宋体' };

const SIZE_BODY = 24; // 半磅，24 = 12pt（小四）
const SIZE_META = 18; // 9pt
const SIZE_CODE = 20; // 10pt
const LINE = 360; // 1.5 倍行距（240 为单倍）

const COLOR_TEXT = '000000';
const COLOR_MUTED = '666666';
const CODE_BG = 'F6F8FA';
const CODE_BORDER = 'D9DEE4';
const RULE_COLOR = 'CCCCCC';

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

  // docx 规定文档不能以表格结尾，补一个空段落
  children.push(new Paragraph({ text: '' }));

  const doc = new Document({
    creator: 'AI Notes',
    title: notes.length === 1 ? notes[0].title : 'AI Notes 导出',
    styles: {
      default: {
        document: {
          run: { font: FONT_BODY, size: SIZE_BODY, color: COLOR_TEXT },
          paragraph: { spacing: { after: 120, line: LINE, lineRule: 'auto' } },
        },
        title: headingStyle(36, 0, 240, AlignmentType.CENTER),
        heading1: headingStyle(32, 320, 160),
        heading2: headingStyle(28, 280, 140),
        heading3: headingStyle(26, 240, 120),
        heading4: headingStyle(24, 200, 100),
        heading5: headingStyle(24, 180, 90),
        heading6: headingStyle(24, 160, 80),
      },
      paragraphStyles: [
        {
          id: 'SourceCode',
          name: 'Source Code',
          basedOn: 'Normal',
          next: 'SourceCode',
          quickFormat: true,
          run: { font: FONT_MONO, size: SIZE_CODE, color: COLOR_TEXT },
          // 代码块整体由外层表格提供底色边框，这里只管行内紧凑
          paragraph: { spacing: { before: 0, after: 0, line: 260, lineRule: 'auto' }, contextualSpacing: true },
        },
        {
          id: 'Quote',
          name: 'Quote',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { color: COLOR_MUTED },
          paragraph: {
            indent: { left: 420 },
            spacing: { before: 60, after: 60, line: LINE, lineRule: 'auto' },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'BBBBBB', space: 10 } },
          },
        },
        {
          id: 'NoteMeta',
          name: 'Note Meta',
          basedOn: 'Normal',
          next: 'Normal',
          run: { size: SIZE_META, color: COLOR_MUTED },
          paragraph: {
            spacing: { before: 0, after: 240, line: 240, lineRule: 'auto' },
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE_COLOR, space: 8 } },
          },
        },
        {
          id: 'ListBody',
          name: 'List Body',
          basedOn: 'Normal',
          next: 'ListBody',
          // 列表项之间不留额外间距，避免 Word 里每条都隔一行
          paragraph: { spacing: { before: 0, after: 0, line: LINE, lineRule: 'auto' }, contextualSpacing: true },
        },
        {
          id: 'TableText',
          name: 'Table Text',
          basedOn: 'Normal',
          next: 'TableText',
          paragraph: { spacing: { before: 0, after: 0, line: 260, lineRule: 'auto' } },
        },
      ],
    },
    numbering: { config: numberingConfig() },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertMillimetersToTwip(25.4),
              bottom: convertMillimetersToTwip(25.4),
              left: convertMillimetersToTwip(31.8),
              right: convertMillimetersToTwip(31.8),
            },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

function headingStyle(size, before, after, alignment) {
  return {
    run: { font: FONT_HEAD, size, bold: true, color: COLOR_TEXT },
    paragraph: {
      spacing: { before, after, line: LINE, lineRule: 'auto' },
      alignment,
      keepNext: true, // 标题不落在页尾单独一行
      keepLines: true,
    },
  };
}

function metaParagraph(note) {
  const bits = [];
  bits.push(`来源：${SOURCE_LABEL[note.source] || note.source || '其他'}`);
  if (note.tags && note.tags.length) bits.push(`标签：${note.tags.join('、')}`);
  if (note.conversation) bits.push(`对话：${note.conversation}`);
  if (note.kind === 'task') bits.push(`任务：${note.status === 'done' ? '已完成' : '进行中'}`);
  if (note.created) bits.push(new Date(note.created).toLocaleDateString('zh-CN'));

  const children = [new TextRun({ text: bits.join('　·　') })];
  if (note.url) {
    children.push(new TextRun({ text: '　·　' }));
    children.push(
      new ExternalHyperlink({
        link: note.url,
        children: [new TextRun({ text: '原始对话', style: 'Hyperlink' })],
      })
    );
  }
  return new Paragraph({ style: 'NoteMeta', children });
}

// 有序列表每个实例独立编号，避免第二个列表接着上一个continue计数
function numberingConfig() {
  const indentFor = (level) => ({ paragraph: { indent: { left: 480 * (level + 1), hanging: 360 } } });
  const config = [
    {
      reference: 'bullets',
      levels: [0, 1, 2, 3].map((level) => ({
        level,
        format: LevelFormat.BULLET,
        text: ['●', '○', '▪', '·'][level],
        alignment: AlignmentType.LEFT,
        style: indentFor(level),
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
        style: indentFor(level),
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

/** opts: { indent, quote, numbering, listLevel } 向下传递 */
function tokensToBlocks(tokens, ctx, opts) {
  const out = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'heading':
        out.push(
          new Paragraph({
            heading: [
              HeadingLevel.HEADING_1,
              HeadingLevel.HEADING_2,
              HeadingLevel.HEADING_3,
              HeadingLevel.HEADING_4,
              HeadingLevel.HEADING_5,
              HeadingLevel.HEADING_6,
            ][Math.min(tok.depth, 6) - 1],
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
        out.push(...tokensToBlocks(tok.tokens || [], ctx, { ...opts, quote: true }));
        break;
      case 'list':
        out.push(...listBlocks(tok, ctx, opts));
        break;
      case 'table':
        out.push(tableBlock(tok, opts), spacerParagraph());
        break;
      case 'hr':
        out.push(
          new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE_COLOR, space: 1 } },
            spacing: { before: 120, after: 240 },
          })
        );
        break;
      case 'html':
        {
          const text = stripHtml(tok.text);
          if (text.trim()) out.push(paragraph([new TextRun({ text })], opts));
        }
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
  if (opts.numbering) {
    props.numbering = opts.numbering;
    props.style = 'ListBody';
  } else if (opts.indent) {
    props.indent = { left: 480 * opts.indent };
  }
  if (opts.quote) props.style = 'Quote';
  return new Paragraph(props);
}

// 表格之间必须隔一个空段落，否则 Word 会把相邻表格并成一个
function spacerParagraph() {
  return new Paragraph({ text: '', spacing: { before: 0, after: 0, line: 120, lineRule: 'auto' } });
}

// 代码块整体放进一个单元格表格：底色和边框连成一片，行与行之间没有缝隙
function codeBlock(text, opts) {
  const lines = String(text).replace(/\n+$/, '').split('\n');
  const noBorder = { style: BorderStyle.SINGLE, size: 4, color: CODE_BORDER };
  const cell = new TableCell({
    shading: { type: ShadingType.CLEAR, fill: CODE_BG, color: 'auto' },
    borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
    margins: { top: 120, bottom: 120, left: 180, right: 180 },
    children: lines.map((line) => new Paragraph({ style: 'SourceCode', children: [new TextRun({ text: line || ' ' })] })),
  });
  const table = new Table({
    rows: [new TableRow({ children: [cell] })],
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    indent: opts.indent || opts.numbering ? { size: 480, type: WidthType.DXA } : undefined,
  });
  return [table, spacerParagraph()];
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
        // 列表项里的代码块、引用等，缩进到与项目文字对齐
        out.push(...tokensToBlocks([tok], ctx, { ...opts, numbering: undefined, indent: level + 1 }));
      }
    }
    if (first) out.push(paragraph([new TextRun({ text: '' })], { ...opts, numbering }));
  }
  return out;
}

function tableBlock(tok, opts) {
  const line = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
  const borders = { top: line, bottom: line, left: line, right: line };
  const colCount = tok.header.length || 1;
  const colWidth = Math.floor(100 / colCount);

  const alignOf = (i) => {
    const a = (tok.align || [])[i];
    if (a === 'center') return AlignmentType.CENTER;
    if (a === 'right') return AlignmentType.RIGHT;
    return AlignmentType.LEFT;
  };

  const cell = (cellTok, i, isHeader) =>
    new TableCell({
      borders,
      width: { size: colWidth, type: WidthType.PERCENTAGE },
      verticalAlign: VerticalAlign.CENTER,
      shading: isHeader ? { type: ShadingType.CLEAR, fill: 'EFEFEF', color: 'auto' } : undefined,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [
        new Paragraph({
          style: 'TableText',
          alignment: alignOf(i),
          children: inlineRuns(cellTok.tokens || [{ type: 'text', text: cellTok.text }], isHeader ? { bold: true } : {}),
        }),
      ],
    });

  const rows = [
    new TableRow({ tableHeader: true, cantSplit: true, children: tok.header.map((c, i) => cell(c, i, true)) }),
  ];
  for (const r of tok.rows) {
    rows.push(new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, i, false)) }));
  }

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    indent: opts.indent ? { size: 480 * opts.indent, type: WidthType.DXA } : undefined,
  });
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
            size: SIZE_CODE,
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
        runs.push(new TextRun({ text: `［图片${tok.text ? '：' + tok.text : ''}］`, color: COLOR_MUTED, ...style }));
        break;
      case 'br':
        runs.push(new TextRun({ text: '', break: 1 }));
        break;
      case 'html':
        {
          const text = stripHtml(tok.text);
          if (text) runs.push(new TextRun({ text, ...style }));
        }
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
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripHtml(s) {
  return decode(String(s || '').replace(/<[^>]+>/g, ''));
}

module.exports = { notesToDocx };
