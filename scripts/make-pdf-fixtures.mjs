// Builds the committed PDF test fixtures in tests/fixtures/pdf/ from minimal
// hand-assembled PDF syntax (no dependencies). Rerun only deliberately:
// tests assert on the exact strings placed here.
//
//   node scripts/make-pdf-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "pdf");

/**
 * Assemble a PDF from numbered object bodies (object 1 first). All content is
 * ASCII so string length equals byte length, which keeps xref offsets honest.
 */
function buildPdf(objectBodies) {
  const header = "%PDF-1.4\n";
  let out = header;
  const offsets = [];
  objectBodies.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objectBodies.length + 1}\n`;
  out += "0000000000 65535 f \n";
  for (const off of offsets) {
    out += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objectBodies.length + 1} /Root 1 0 R >>\n`;
  out += `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, "ascii");
}

function stream(dict, content) {
  return `<< ${dict}/Length ${content.length} >>\nstream\n${content}\nendstream`;
}

// invoice.pdf: one page with a real text layer (three Tj lines).
const invoiceContent = [
  "BT /F1 12 Tf 72 720 Td (INVOICE INV-2099-0001) Tj ET",
  "BT /F1 12 Tf 72 700 Td (Total: $12,345.67) Tj ET",
  "BT /F1 12 Tf 72 680 Td (Payment terms NET 45) Tj ET",
].join("\n");
const invoice = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]" +
    " /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  stream("", invoiceContent),
]);

// scanned.pdf: one page, drawing operators only, no text layer at all.
const scanned = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
  stream("", "1 w 72 72 468 648 re S"),
]);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "invoice.pdf"), invoice);
writeFileSync(join(outDir, "scanned.pdf"), scanned);
console.log(`invoice.pdf ${invoice.length} bytes`);
console.log(`scanned.pdf ${scanned.length} bytes`);
