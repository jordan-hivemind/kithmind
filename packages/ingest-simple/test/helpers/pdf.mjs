// A hand-built, minimal multi-page PDF, for tests only: no PDF library
// dependency, just enough structure (Catalog, Pages, one Page object and one
// content stream per page, base-14 Helvetica) for poppler's `pdftotext` and
// `pdftoppm` -- what `src/convert.ts` actually shells out to -- to read it.
// `pages` is an array of plain-ASCII strings, one per output page; a line
// break inside a page starts a new line of text on that page.

function escapePdfText(line) {
  return line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function buildPdf(pages) {
  let buf = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const offsets = [];
  function addObject(text) {
    offsets.push(buf.length);
    buf = Buffer.concat([buf, Buffer.from(text, "latin1")]);
  }

  const pageCount = pages.length;
  const pageObjIds = [];
  const contentObjIds = [];
  let nextId = 4; // 1 = Catalog, 2 = Pages, 3 = Font
  for (let i = 0; i < pageCount; i += 1) pageObjIds.push(nextId++);
  for (let i = 0; i < pageCount; i += 1) contentObjIds.push(nextId++);

  addObject("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const kids = pageObjIds.map((id) => `${id} 0 R`).join(" ");
  addObject(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);
  addObject("3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

  for (let i = 0; i < pageCount; i += 1) {
    addObject(
      `${pageObjIds[i]} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjIds[i]} 0 R >>\nendobj\n`,
    );
  }

  for (let i = 0; i < pageCount; i += 1) {
    const lines = pages[i].split("\n").map(escapePdfText);
    const tj = lines
      .map((line, index) => (index === 0 ? `(${line}) Tj` : `T* (${line}) Tj`))
      .join("\n");
    const stream = `BT /F1 14 Tf 72 720 Td 16 TL\n${tj}\nET`;
    const streamBytes = Buffer.byteLength(stream, "latin1");
    addObject(
      `${contentObjIds[i]} 0 obj\n<< /Length ${streamBytes} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  }

  const xrefStart = buf.length;
  const totalObjects = 3 + pageCount * 2;
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < totalObjects; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.concat([buf, Buffer.from(xref, "latin1")]);
}
