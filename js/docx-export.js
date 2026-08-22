import { buildRenderableBlocks } from './document-model.js';
import { citationMap } from './citation-utils.js';

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textRuns(text) {
  return `<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function paragraph(text, style = 'BodyText') {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${textRuns(text)}</w:p>`;
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
  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="0" w:type="auto"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="6" w:space="0" w:color="BDB6A8"/>
        <w:left w:val="single" w:sz="6" w:space="0" w:color="BDB6A8"/>
        <w:bottom w:val="single" w:sz="6" w:space="0" w:color="BDB6A8"/>
        <w:right w:val="single" w:sz="6" w:space="0" w:color="BDB6A8"/>
        <w:insideH w:val="single" w:sz="6" w:space="0" w:color="D4CEC0"/>
        <w:insideV w:val="single" w:sz="6" w:space="0" w:color="D4CEC0"/>
      </w:tblBorders>
    </w:tblPr>
    ${rows.map((row, rowIndex) => `<w:tr>${row.map(cell => `<w:tc><w:tcPr>${rowIndex === 0 ? '<w:shd w:fill="F4EFE4"/>' : ''}</w:tcPr>${paragraph(cell || '', rowIndex === 0 ? 'TableHead' : 'TableCell')}</w:tc>`).join('')}</w:tr>`).join('')}
  </w:tbl>`;
}

function buildDocxParts(project, doc, citations) {
  const byId = citationMap(citations);
  const renderable = buildRenderableBlocks(doc, byId);
  const blocks = [];
  const media = [];
  const relationships = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'];
  let imageIndex = 1;

  renderable.forEach(block => {
    if (block.type === 'title') { blocks.push(paragraph(block.text, 'Title')); return; }
    if (block.type === 'heading') { blocks.push(paragraph(block.text, 'Heading1')); return; }
    if (block.type === 'paragraph') { blocks.push(paragraph(block.text, 'BodyText')); return; }
    if (block.type === 'blockquote') { blocks.push(paragraph(block.text, 'BodyQuote')); return; }
    if (block.type === 'reference') { blocks.push(paragraph(block.text, 'Reference')); return; }
    if (block.type === 'list') {
      block.items.forEach((item, index) => blocks.push(paragraph(`${block.ordered ? `${index + 1}. ` : '• '}${item}`, 'BodyText')));
      return;
    }
    if (block.type === 'figure') {
      const caption = `图${block.number} ${block.caption || block.alt || '未命名图片'}`;
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
      return;
    }
    if (block.type === 'table') {
      if (block.rows?.length) blocks.push(tableXml(block.rows));
      blocks.push(paragraph(`表${block.number} ${block.caption || '未命名表格'}`, 'Caption'));
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
        <w:pgSz w:w="11906" w:h="16838"/>
        <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
      </w:sectPr>
    </w:body>
  </w:document>`;

  return { documentXml, media, relationships };
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
  <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
      <w:name w:val="Normal"/>
      <w:qFormat/>
      <w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Title">
      <w:name w:val="Title"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>
      <w:rPr><w:b/><w:sz w:val="32"/><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Heading1">
      <w:name w:val="Heading 1"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
      <w:rPr><w:b/><w:sz w:val="28"/><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="BodyText">
      <w:name w:val="Body Text"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:ind w:firstLine="420"/><w:spacing w:line="480" w:lineRule="auto"/></w:pPr>
      <w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="BodyQuote">
      <w:name w:val="Body Quote"/>
      <w:basedOn w:val="BodyText"/>
      <w:pPr><w:ind w:left="420"/><w:spacing w:line="420" w:lineRule="auto"/></w:pPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Caption">
      <w:name w:val="Caption"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="120"/></w:pPr>
      <w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="22"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="TableHead">
      <w:name w:val="Table Head"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:jc w:val="center"/></w:pPr>
      <w:rPr><w:b/><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="22"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="TableCell">
      <w:name w:val="Table Cell"/>
      <w:basedOn w:val="Normal"/>
      <w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="22"/></w:rPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Reference">
      <w:name w:val="Reference"/>
      <w:basedOn w:val="Normal"/>
      <w:pPr><w:ind w:left="420" w:hanging="420"/><w:spacing w:line="360" w:lineRule="auto"/></w:pPr>
      <w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="22"/></w:rPr>
    </w:style>
  </w:styles>`;
}

export function createDocxBlob(project, doc, citations) {
  const { documentXml, media, relationships } = buildDocxParts(project, doc, citations);
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
      </Relationships>`,
    },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/styles.xml', content: buildStylesXml() },
    {
      name: 'docProps/core.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:dcterms="http://purl.org/dc/terms/"
        xmlns:dcmitype="http://purl.org/dc/dcmitype/"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <dc:title>${xmlEscape(project.title || '未命名论文')}</dc:title>
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
