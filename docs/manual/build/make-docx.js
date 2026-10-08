'use strict';
// 사용 설명서 Word 파일 만들기
// 사용법: node make-docx.js <출력.docx> [본문글꼴] [제목글꼴]
//   Word 용: 맑은 고딕 (윈도우 기본) / PDF 용: 나눔 글꼴 (PDF 에 글꼴이 들어감)
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, AlignmentType,
  WidthType, BorderStyle, ShadingType, LevelFormat, Footer, PageNumber, PageBreak, HeightRule, LineRuleType,
} = require('docx');
const content = require('./content');

const OUT = process.argv[2] || 'manual.docx';
const BODY_FONT = process.argv[3] || '맑은 고딕';
const HEAD_FONT = process.argv[4] || BODY_FONT;
const IMG = path.join(__dirname, 'img');

const C = {
  violet: '6D28D9', violetSoft: 'F1EAFE', ink: '1F1B2E', muted: '6B6780', line: 'DDD6F3',
  tip: 'E8F7EE', tipBar: '16A34A', warn: 'FFF4E0', warnBar: 'D97706', adult: 'FDECEC', adultBar: 'DC2626', info: 'EEF2FF', infoBar: '4F46E5',
};
const PAGE_W = 11906; // A4 (DXA)
const MARGIN = 1020; // 1.8cm
const CONTENT_W = PAGE_W - MARGIN * 2;

/** "**굵게**" 표시를 TextRun 들로 */
function runs(text, opts = {}) {
  const out = [];
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  for (const part of parts) {
    const bold = /^\*\*.*\*\*$/.test(part);
    out.push(new TextRun({
      text: bold ? part.slice(2, -2) : part,
      bold: bold || !!opts.bold,
      color: opts.color || (bold ? C.ink : undefined),
      size: opts.size,
      font: { name: opts.font || BODY_FONT, eastAsia: opts.font || BODY_FONT },
    }));
  }
  return out;
}

function imgSize(file) {
  // PNG 헤더에서 크기 읽기
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function boxColors(kind) {
  return ({
    tip: [C.tip, C.tipBar, '꿀팁'],
    warn: [C.warn, C.warnBar, '조심해요'],
    adult: [C.adult, C.adultBar, '어른과 함께'],
    info: [C.info, C.infoBar, '알아 두기'],
  })[kind] || [C.info, C.infoBar, '알아 두기'];
}

const boxChars = (b) => String(b.text || '').length + (b.items || []).reduce((a, x) => a + String(x).length, 0);
let stepsInstance = 0;
const children = [];

for (const b of content) {
  switch (b.t) {
    case 'title': {
      children.push(new Paragraph({ spacing: { before: 1800 } }));
      const icon = path.join(IMG, b.icon);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ type: 'png', data: fs.readFileSync(icon), transformation: { width: 170, height: 170 } })],
      }));
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 400, after: 120 },
        children: runs(b.title, { bold: true, size: 64, color: C.violet, font: HEAD_FONT }) }));
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 360 },
        children: runs(b.sub, { bold: true, size: 40, color: C.ink, font: HEAD_FONT }) }));
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 1600 },
        shading: { type: ShadingType.CLEAR, fill: C.violetSoft, color: 'auto' },
        children: runs(b.tag, { size: 28, color: C.violet, font: HEAD_FONT }) }));
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: runs(b.note, { size: 20, color: C.muted }) }));
      break;
    }
    case 'toc':
      children.push(new Paragraph({ spacing: { after: 240 }, children: runs(b.title, { bold: true, size: 44, color: C.violet, font: HEAD_FONT }) }));
      for (const it of b.items) {
        children.push(new Paragraph({
          spacing: { after: 110 }, indent: { left: 360 },
          border: { bottom: { style: BorderStyle.DOTTED, size: 4, color: C.line, space: 4 } },
          children: runs(it, { size: 26 }),
        }));
      }
      break;
    case 'pagebreak':
      children.push(new Paragraph({ children: [new PageBreak()] }));
      break;
    case 'h1':
      children.push(new Paragraph({
        pageBreakBefore: false, keepNext: true, spacing: { before: 420, after: 160 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: C.violet, space: 6 } },
        children: runs(b.text, { bold: true, size: 36, color: C.violet, font: HEAD_FONT }),
      }));
      break;
    case 'h2':
      children.push(new Paragraph({
        keepNext: true, spacing: { before: 250, after: 110 },
        children: [new TextRun({ text: '■ ', color: C.violet, size: 28, font: { name: HEAD_FONT, eastAsia: HEAD_FONT } }), ...runs(b.text, { bold: true, size: 28, color: C.ink, font: HEAD_FONT })],
      }));
      break;
    case 'p':
      children.push(new Paragraph({ spacing: { after: 120, line: 325 }, children: runs(b.text, { size: 22 }) }));
      break;
    case 'steps': {
      const instance = ++stepsInstance;
      for (const it of b.items) {
        children.push(new Paragraph({
          numbering: { reference: 'steps', level: 0, instance },
          spacing: { after: 80, line: 305 },
          children: runs(it, { size: 22 }),
        }));
      }
      children.push(new Paragraph({ spacing: { after: 30 } }));
      break;
    }
    case 'bullets':
      for (const it of b.items) {
        children.push(new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 85, line: 305 }, children: runs(it, { size: 22 }) }));
      }
      break;
    case 'box': {
      const [fill, bar, label] = boxColors(b.kind);
      const paras = [new Paragraph({ spacing: { after: 80 }, children: runs(`${label} | ${b.title}`, { bold: true, size: 22, color: bar, font: HEAD_FONT }) })];
      if (b.text) paras.push(new Paragraph({ spacing: { after: 40, line: 310 }, children: runs(b.text, { size: 21 }) }));
      for (const it of b.items || []) {
        paras.push(new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 40, line: 310 }, children: runs(it, { size: 21 }) }));
      }
      const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
      children.push(new Table({
        width: { size: CONTENT_W, type: WidthType.DXA },
        columnWidths: [CONTENT_W],
        rows: [new TableRow({
          cantSplit: boxChars(b) < 700, // 아주 긴 상자만 쪽 사이에서 나뉘게 한다
          children: [new TableCell({
            width: { size: CONTENT_W, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
            margins: { top: 100, bottom: 100, left: 200, right: 200 },
            borders: { left: { style: BorderStyle.SINGLE, size: 36, color: bar }, top: none, bottom: none, right: none },
            children: paras,
          })],
        })],
      }));
      children.push(new Paragraph({ spacing: { after: 100 } }));
      break;
    }
    case 'img': {
      const file = path.join(IMG, b.file);
      const { w, h } = imgSize(file);
      const widthPx = Math.round((b.width || 15) / 2.54 * 96);
      const heightPx = Math.round((widthPx * h) / w);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 80, after: 30 },
        children: [new ImageRun({ type: 'png', data: fs.readFileSync(file), transformation: { width: widthPx, height: heightPx } })],
      }));
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 150 }, children: runs(`▲ ${b.caption}`, { size: 18, color: C.muted }) }));
      break;
    }
    case 'table': {
      const widths = b.widths.map((p) => Math.round((CONTENT_W * p) / 100));
      widths[widths.length - 1] = CONTENT_W - widths.slice(0, -1).reduce((a, x) => a + x, 0);
      const border = { style: BorderStyle.SINGLE, size: 4, color: C.line };
      const borders = { top: border, bottom: border, left: border, right: border };
      const cell = (text, i, head, zebra) => new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        borders,
        shading: { type: ShadingType.CLEAR, fill: head ? C.violet : (zebra ? 'FAF8FF' : 'FFFFFF'), color: 'auto' },
        margins: { top: 45, bottom: 45, left: 110, right: 110 },
        children: [new Paragraph({ alignment: text === '□' ? AlignmentType.CENTER : AlignmentType.LEFT, children: runs(text, { size: head ? 21 : 20, bold: head, color: head ? 'FFFFFF' : undefined }) })],
      });
      children.push(new Table({
        width: { size: CONTENT_W, type: WidthType.DXA },
        columnWidths: widths,
        rows: [
          new TableRow({ tableHeader: true, cantSplit: true, height: { value: 420, rule: HeightRule.ATLEAST }, children: b.head.map((t, i) => cell(t, i, true)) }),
          ...b.rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((t, i) => cell(t, i, false, ri % 2 === 1)) })),
        ],
      }));
      children.push(new Paragraph({ spacing: { after: 120 } }));
      break;
    }
    default:
      throw new Error(`모르는 블록: ${b.t}`);
  }
}

// 문서 맨 끝의 빈 문단이 새 쪽을 만들지 않게 아주 작게 만든다
if (children.length && ['box', 'table'].includes(content[content.length - 1].t)) {
  children[children.length - 1] = new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT }, children: [new TextRun({ text: '', size: 2 })] });
}

const doc = new Document({
  creator: 'AnimeMaker',
  title: 'AnimeMaker V2 사용 설명서',
  description: '초등학생도 따라 할 수 있는 AnimeMaker V2 사용 설명서 (컴퓨터 + 안드로이드 폰)',
  styles: { default: { document: { run: { font: { name: BODY_FONT, eastAsia: BODY_FONT }, size: 22, color: C.ink } } } },
  numbering: {
    config: [
      { reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 560, hanging: 400 } }, run: { bold: true, color: C.violet } } }] },
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '●', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 520, hanging: 320 } }, run: { color: C.violet, size: 16 } } }] },
    ],
  },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: 1000, bottom: 1000, left: MARGIN, right: MARGIN } }, titlePage: true },
    footers: {
      default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: '- ', color: C.muted, size: 18 }), new TextRun({ children: [PageNumber.CURRENT], color: C.muted, size: 18 }), new TextRun({ text: ' -', color: C.muted, size: 18 })] })] }),
      first: new Footer({ children: [new Paragraph({})] }),
    },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUT, buf); console.log('wrote', OUT, buf.length); });
