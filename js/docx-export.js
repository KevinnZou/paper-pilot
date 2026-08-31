import { buildRenderableBlocks, buildCitationNumberMap } from './document-model.js';
import { citationMap } from './citation-utils.js';
import { meaningfulTitle } from './title-utils.js';
import { getTemplate } from './project.js';

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textRuns(text, supNums = null) {
  if (!supNums || !/\[\d+\]/.test(String(text || ''))) {
    return `<w:r><w:t xml:space="preserve">${xmlEscape(String(text || ''))}</w:t></w:r>`;
  }
  // GB/T 7714 顺序编码制：正文引用编号上标
  return String(text).split(/(\[\d+\])/g).map(part => {
    const m = /^\[(\d+)\]$/.exec(part);
    if (m && supNums.has(Number(m[1]))) {
      return `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t xml:space="preserve">${xmlEscape(part)}</w:t></w:r>`;
    }
    return `<w:r><w:t xml:space="preserve">${xmlEscape(part)}</w:t></w:r>`;
  }).join('');
}

function paragraph(text, style = 'BodyText', options = {}) {
  const pageBreak = options.pageBreakBefore ? '<w:pageBreakBefore/>' : '';
  const align = options.align ? `<w:jc w:val="${options.align}"/>` : '';
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${pageBreak}${align}</w:pPr>${textRuns(text, options?.supNums)}</w:p>`;
}

function tocParagraph(text, style, pageNo) {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(String(text || ''))}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>${xmlEscape(String(pageNo || ''))}</w:t></w:r></w:p>`;
}

function pageBreakParagraph() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function isPageBreakXml(xml) {
  return /<w:br w:type="page"/.test(xml || '');
}

function fieldRun(instruction) {
  return `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
}

function crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function uint16LE(n) {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function uint32LE(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function concatArrays(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  chunks.forEach(chunk => {
    out.set(chunk, offset);
    offset += chunk.length;
  });
  return out;
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime();

  files.forEach(file => {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
    const crc = crc32(dataBytes);
    const localHeader = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04,
      ...uint16LE(20),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint16LE(dosTime),
      ...uint16LE(dosDate),
      ...uint32LE(crc),
      ...uint32LE(dataBytes.length),
      ...uint32LE(dataBytes.length),
      ...uint16LE(nameBytes.length),
      ...uint16LE(0),
    ]);
    localParts.push(localHeader, nameBytes, dataBytes);

    const centralHeader = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02,
      ...uint16LE(20),
      ...uint16LE(20),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint16LE(dosTime),
      ...uint16LE(dosDate),
      ...uint32LE(crc),
      ...uint32LE(dataBytes.length),
      ...uint32LE(dataBytes.length),
      ...uint16LE(nameBytes.length),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint32LE(0),
      ...uint32LE(offset),
    ]);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + dataBytes.length;
  });

  const centralDir = concatArrays(centralParts);
  const localDir = concatArrays(localParts);
  const end = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06,
    ...uint16LE(0),
    ...uint16LE(0),
    ...uint16LE(files.length),
    ...uint16LE(files.length),
    ...uint32LE(centralDir.length),
    ...uint32LE(localDir.length),
    ...uint16LE(0),
  ]);
  return concatArrays([localDir, centralDir, end]);
}

function dataUrlToBytes(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  const mime = match[1];
  const raw = atob(match[2]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return { mime, bytes };
}

function imageDrawingXml(relId, widthPx, heightPx) {
  const maxWidth = 520;
  const baseWidth = widthPx || 480;
  const baseHeight = heightPx || 300;
  const ratio = Math.min(1, maxWidth / baseWidth);
  const width = Math.max(220, Math.round(baseWidth * ratio));
  const height = Math.max(140, Math.round(baseHeight * ratio));
  const cx = width * 9525;
  const cy = height * 9525;
  return `<w:p>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:r>
      <w:drawing>
        <wp:inline distT="0" distB="0" distL="0" distR="0">
          <wp:extent cx="${cx}" cy="${cy}"/>
          <wp:docPr id="1" name="Picture"/>
          <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:nvPicPr>
                  <pic:cNvPr id="0" name="Picture"/>
                  <pic:cNvPicPr/>
                </pic:nvPicPr>
                <pic:blipFill>
                  <a:blip r:embed="${relId}"/>
                  <a:stretch><a:fillRect/></a:stretch>
                </pic:blipFill>
                <pic:spPr>
                  <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
                  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                </pic:spPr>
              </pic:pic>
            </a:graphicData>
          </a:graphic>
        </wp:inline>
      </w:drawing>
    </w:r>
  </w:p>`;
}

function tableXml(rows) {
  const colCount = Math.max(1, ...rows.map(row => row.length));
  const tableWidth = 8504;
  const colWidth = Math.floor(tableWidth / colCount);
  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="${tableWidth}" w:type="dxa"/>
      <w:tblLayout w:type="fixed"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="12" w:space="0" w:color="000000"/>
        <w:left w:val="nil"/>
        <w:bottom w:val="single" w:sz="12" w:space="0" w:color="000000"/>
        <w:right w:val="nil"/>
        <w:insideH w:val="single" w:sz="6" w:space="0" w:color="000000"/>
        <w:insideV w:val="nil"/>
      </w:tblBorders>
      <w:tblCellMar>
        <w:top w:w="100" w:type="dxa"/>
        <w:left w:w="120" w:type="dxa"/>
        <w:bottom w:w="100" w:type="dxa"/>
        <w:right w:w="120" w:type="dxa"/>
      </w:tblCellMar>
    </w:tblPr>
    <w:tblGrid>${Array.from({ length: colCount }, () => `<w:gridCol w:w="${colWidth}"/>`).join('')}</w:tblGrid>
    ${rows.map((row, rowIndex) => `<w:tr>${Array.from({ length: colCount }, (_, i) => row[i] || '').map(cell => `<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/>${rowIndex === 0 ? '<w:shd w:fill="F4EFE4"/>' : ''}</w:tcPr>${paragraph(cell || '', rowIndex === 0 ? 'TableHead' : 'TableCell')}</w:tc>`).join('')}</w:tr>`).join('')}
  </w:tbl>`;
}

function formulaTableXml(text, number) {
  return `<w:tbl>
    <w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr>
    <w:tr>
      <w:tc><w:tcPr><w:tcW w:w="7400" w:type="dxa"/></w:tcPr>${paragraph(text || '', 'Formula', { align: 'center' })}</w:tc>
      <w:tc><w:tcPr><w:tcW w:w="900" w:type="dxa"/></w:tcPr>${paragraph(`（${number}）`, 'Formula', { align: 'right' })}</w:tc>
    </w:tr>
  </w:tbl>`;
}

function buildHeaderXml(project) {
  const title = meaningfulTitle(project?.researchDesign?.title, project?.title) || '论文正文';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
  <w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:p>
      <w:pPr>
        <w:jc w:val="center"/>
        <w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="000000"/></w:pBdr>
        <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
      </w:pPr>
      <w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="21"/></w:rPr><w:t>${xmlEscape(title)}</w:t></w:r>
    </w:p>
  </w:hdr>`;
}

function buildFooterXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
  <w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
      <w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="21"/></w:rPr></w:r>
      ${fieldRun('PAGE')}
    </w:p>
  </w:ftr>`;
}

function buildDocxParts(project, doc, citations, template = DEFAULT_THEME) {
  const byId = citationMap(citations);
  const renderable = buildRenderableBlocks(doc, byId);
  const supNums = new Set([...buildCitationNumberMap(doc).values()]);
  const blocks = [];
  const media = [];
  const relationships = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'];
  let imageIndex = 1;
  let chapterNo = 0;
  let figureNo = 0;
  let tableNo = 0;
  let formulaNo = 0;
  const chapterIndexFrom = text => {
    const match = String(text || '').match(/第\s*(\d+)\s*章/);
    return match ? Number(match[1]) : 0;
  };

  let tocAdded = false;
  renderable.forEach(block => {
    if (block.type === 'title') { blocks.push(paragraph(block.text, 'Title')); return; }
    if (block.type === 'heading') {
      // GB/T 7713.2：学位论文应有"目录"（正文前）。放在第一个正文章节标题前；并给一份静态章节列表（打开即见）
      if (block.role === 'section' && !tocAdded) {
        tocAdded = true;
        if (blocks.length && !isPageBreakXml(blocks[blocks.length - 1])) blocks.push(pageBreakParagraph());
        blocks.push(paragraph('目录', 'HeadingChapter'));
        (project.outline || []).forEach((ch, chapterIndex) => {
          const chapterTitle = String(ch?.chapter || '').trim();
          const chapterPageNo = chapterIndex + 1;
          if (chapterTitle) blocks.push(tocParagraph(chapterTitle, 'Toc1', chapterPageNo));
          (Array.isArray(ch?.sections) ? ch.sections : []).forEach((s, sectionIndex) => {
            const subTitle = String(s || '').trim();
            if (subTitle) blocks.push(tocParagraph(subTitle, 'Toc2', sectionIndex ? '' : chapterPageNo));
          });
        });
        blocks.push(pageBreakParagraph());
      }
      if (block.role === 'section') {
        chapterNo = chapterIndexFrom(block.text) || chapterNo + 1;
        figureNo = 0;
        tableNo = 0;
        formulaNo = 0;
        if (blocks.length && !isPageBreakXml(blocks[blocks.length - 1])) {
          blocks.push(pageBreakParagraph());
        }
        blocks.push(paragraph(block.text, 'HeadingChapter'));
        return;
      }
      if (['abstract', 'references', 'ack'].includes(block.role)) {
        if (blocks.length) blocks.push(pageBreakParagraph());
        blocks.push(paragraph(block.text, 'HeadingChapter'));
        return;
      }
      blocks.push(paragraph(block.text, block.level >= 4 ? 'Heading3' : 'Heading2'));
      return;
    }
    if (block.type === 'notes_heading') { blocks.push(paragraph(block.text, 'HeadingChapter')); return; }
    if (block.type === 'paragraph') { blocks.push(paragraph(block.text, 'BodyText', { supNums })); return; }
    if (block.type === 'blockquote') { blocks.push(paragraph(block.text, 'BodyQuote', { supNums })); return; }
    if (block.type === 'reference') { blocks.push(paragraph(block.text, 'Reference')); return; }
    if (block.type === 'note') { blocks.push(paragraph(`[注${block.number}] ${block.text}`, 'Reference')); return; }
    if (block.type === 'list') {
      block.items.forEach((item, index) => blocks.push(paragraph(`${block.ordered ? `${index + 1}. ` : '• '}${item}`, 'BodyText')));
      return;
    }
    if (block.type === 'formula') {
      formulaNo += 1;
      const number = chapterNo ? `${chapterNo}.${formulaNo}` : block.number;
      blocks.push(formulaTableXml(block.latex || '', number));
      if (block.label) blocks.push(paragraph(block.label, 'Caption'));
      if (block.note) blocks.push(paragraph(`说明：${block.note}`, 'BodyQuote'));
      return;
    }
    if (block.type === 'figure') {
      figureNo += 1;
      const number = chapterNo ? `${chapterNo}.${figureNo}` : block.number;
      const caption = `图 ${number} ${block.caption || block.alt || '未命名图片'}`;
      const data = dataUrlToBytes(block.src);
      if (data && /image\/(png|jpeg)/.test(data.mime)) {
        const ext = data.mime === 'image/png' ? 'png' : 'jpg';
        const relId = `rIdImg${imageIndex}`;
        const filename = `media/image${imageIndex}.${ext}`;
        media.push({ name: `word/${filename}`, content: data.bytes, mime: data.mime });
        relationships.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${filename}"/>`);
        blocks.push(imageDrawingXml(relId, block.width, block.height));
        imageIndex += 1;
      }
      blocks.push(paragraph(caption, 'Caption'));
      if (block.note) blocks.push(paragraph(`说明：${block.note}`, 'BodyQuote'));
      return;
    }
    if (block.type === 'table') {
      tableNo += 1;
      const number = chapterNo ? `${chapterNo}.${tableNo}` : block.number;
      blocks.push(paragraph(`表 ${number} ${block.caption || '未命名表格'}`, 'Caption'));
      if (block.rows?.length) blocks.push(tableXml(block.rows));
      if (block.note) blocks.push(paragraph(`说明：${block.note}`, 'BodyQuote'));
      return;
    }
  });

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
  <w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
    xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
    xmlns:o="urn:schemas-microsoft-com:office:office"
    xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
    xmlns:v="urn:schemas-microsoft-com:vml"
    xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
    xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
    xmlns:w10="urn:schemas-microsoft-com:office:word"
    xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
    xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
    xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
    xmlns:wne="http://schemas.microsoft.com/office/2006/wordml"
    xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
    mc:Ignorable="w14 wp14">
    <w:body>
      ${blocks.join('')}
      <w:sectPr>
        <w:headerReference w:type="default" r:id="rIdHeader"/>
        <w:footerReference w:type="default" r:id="rIdFooter"/>
        <w:pgSz w:w="11906" w:h="16838"/>
        <w:pgMar w:top="${Math.round((template.margins) ? template.margins.top*567 : 1701)}" w:right="${Math.round(template.margins.right*567)}" w:bottom="${Math.round(template.margins.bottom*567)}" w:left="${Math.round(template.margins.left*567)}" w:header="1247" w:footer="1247" w:gutter="0"/>
      </w:sectPr>
    </w:body>
  </w:document>`;

  return { documentXml, media, relationships };
}

function buildStylesXml(t) {
  const sz = pt => Math.round(pt * 2);
  const body = `w:rFonts w:ascii="${t.bodyFontLatin}" w:eastAsia="${t.bodyFont}"`;
  const bodySz = sz(t.bodySize);
  const head = size => `w:b/><w:sz w:val="${sz(size)}"/><w:rFonts w:ascii="Arial" w:eastAsia="${t.headingFont}"`;
  const line = Math.round((t.lineHeight || 1.5) * 240); // 多倍行距 -> 2xx twips
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
  <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
      <w:name w:val="Normal"/>
      <w:qFormat/>
      <w:rPr><${body}/><w:sz w:val="${bodySz}"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Title">
      <w:name w:val="Title"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:jc w:val="center"/><w:spacing w:after="480"/></w:pPr>
      <w:rPr><${head(22)}/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="HeadingChapter">
      <w:name w:val="Chapter Heading"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="560" w:line="240" w:lineRule="auto"/><w:keepNext/></w:pPr>
      <w:rPr><${head(t.headingSize)}/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Heading1">
      <w:name w:val="Heading 1"/>
      <w:basedOn w:val="HeadingChapter"/>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Heading2">
      <w:name w:val="Heading 2"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:spacing w:before="360" w:after="120" w:line="${Math.round(line*0.9)}" w:lineRule="exact"/><w:keepNext/></w:pPr>
      <w:rPr><${head(14)}/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Heading3">
      <w:name w:val="Heading 3"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:spacing w:before="240" w:after="120" w:line="${Math.round(line*0.9)}" w:lineRule="exact"/><w:keepNext/></w:pPr>
      <w:rPr><${head(12)}/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="BodyText">
      <w:name w:val="Body Text"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:ind w:firstLineChars="200" w:firstLine="480"/><w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="auto"/></w:pPr>
      <w:rPr><${body}/><w:sz w:val="${bodySz}"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="BodyQuote">
      <w:name w:val="Body Quote"/>
      <w:basedOn w:val="BodyText"/>
      <w:pPr><w:ind w:left="480" w:firstLine="480"/><w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="auto"/></w:pPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Caption">
      <w:name w:val="Caption"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="120" w:line="240" w:lineRule="auto"/></w:pPr>
      <w:rPr><${body}/><w:sz w:val="${Math.max(21, bodySz - 2)}"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Formula">
      <w:name w:val="Formula"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:spacing w:before="120" w:after="120" w:line="240" w:lineRule="auto"/></w:pPr>
      <w:rPr><${body}/><w:sz w:val="${bodySz}"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="TableHead">
      <w:name w:val="Table Head"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="60" w:line="240" w:lineRule="auto"/></w:pPr>
      <w:rPr><w:b/><${body}/><w:sz w:val="${Math.max(21, bodySz - 2)}"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="TableCell">
      <w:name w:val="Table Cell"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="60" w:line="240" w:lineRule="auto"/></w:pPr>
      <w:rPr><${body}/><w:sz w:val="${Math.max(21, bodySz - 2)}"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Reference">
      <w:name w:val="Reference"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:ind w:left="567" w:hanging="567"/><w:spacing w:before="60" w:after="0" w:line="320" w:lineRule="exact"/></w:pPr>
      <w:rPr><${body}/><w:sz w:val="${Math.max(21, bodySz - 4)}"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Toc1">
      <w:name w:val="TOC 1"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="8504"/></w:tabs><w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="auto"/></w:pPr>
      <w:rPr><${body}/><w:sz w:val="${bodySz}"/><w:b/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Toc2">
      <w:name w:val="TOC 2"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:ind w:left="420"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="8504"/></w:tabs><w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="auto"/></w:pPr>
      <w:rPr><${body}/><w:sz w:val="${Math.max(21, bodySz - 1)}"/></w:rPr>
    </w:style>
  </w:styles>`;
}

const DEFAULT_THEME = { margins: { top: 3, bottom: 3, left: 3, right: 3 }, bodyFont: '宋体', bodyFontLatin: 'Times New Roman', bodySize: 12, headingFont: '黑体', headingSize: 16, lineHeight: 1.5 };

export function createDocxBlob(project, doc, citations) {
  const template = getTemplate(project);
  const { documentXml, media, relationships } = buildDocxParts(project, doc, citations, template);
  const files = [
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        ${media.some(file => file.mime === 'image/png') ? '<Default Extension="png" ContentType="image/png"/>' : ''}
        ${media.some(file => file.mime === 'image/jpeg') ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : ''}
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
        <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
        <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
        <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
        <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
      </Types>`,
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
        <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
      </Relationships>`,
    },
    {
      name: 'word/_rels/document.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        ${relationships.join('')}
        <Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
        <Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
      </Relationships>`,
    },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/styles.xml', content: buildStylesXml(template) },
    { name: 'word/header1.xml', content: buildHeaderXml(project) },
    { name: 'word/footer1.xml', content: buildFooterXml() },
    {
      name: 'docProps/core.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:dcterms="http://purl.org/dc/terms/"
        xmlns:dcmitype="http://purl.org/dc/dcmitype/"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <dc:title>${xmlEscape(meaningfulTitle(project.title) || '论文全文')}</dc:title>
        <dc:creator>PaperPilot</dc:creator>
      </cp:coreProperties>`,
    },
    {
      name: 'docProps/app.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
        xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
        <Application>PaperPilot</Application>
      </Properties>`,
    },
    ...media,
  ];

  return new Blob([buildZip(files)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}
