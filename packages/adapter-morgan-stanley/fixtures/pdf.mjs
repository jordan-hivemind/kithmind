// A minimal, dependency-free PDF writer for test fixtures only: one page,
// one uncompressed content stream, Helvetica, one `(...) Tj` per line. Exists
// so src/adapter.mjs's extractStatementText has a real (if tiny) PDF to run
// against without pulling in a PDF library. ponytail: produces exactly what
// this test suite needs -- one page, no compression, no embedded fonts --
// not a general-purpose PDF writer.

function escapePdfString(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** `lines` becomes the PDF's extractable text, one line per `Tj` operator. */
export function buildMinimalPdf(lines) {
  const content =
    "BT /F1 10 Tf 12 TL 50 750 Td\n" +
    lines.map((line) => `(${escapePdfString(line)}) Tj T*`).join("\n") +
    "\nET";
  const contentByteLength = Buffer.byteLength(content, "latin1");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${contentByteLength} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}
