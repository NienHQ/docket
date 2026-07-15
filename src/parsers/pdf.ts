import type { AttachmentParser } from "../types.js";

/**
 * PDF text-layer extractor over pdfjs-dist (pure JS, deterministic). Loaded
 * lazily inside parse() so importing the package never pays for pdfjs.
 * Scanned PDFs (no text layer) yield empty text; OCR stays out of scope.
 * Malformed bytes reject; the indexer treats that as "no derived text" and
 * caches nothing, so a later parser version can still pick the blob up.
 */
export class PdfTextParser implements AttachmentParser {
  readonly tool: string = "pdf-text";
  readonly version: string = "1";
  readonly mimes: string[] = ["application/pdf"];

  async parse(bytes: Uint8Array): Promise<{ text: string; meta?: Record<string, string> }> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // pdfjs may transfer the buffer it is handed; give it a private copy
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      useWorkerFetch: false,
      disableFontFace: true,
      verbosity: 0, // errors only: keeps parser warnings out of host logs
    });
    const doc = await task.promise;
    try {
      const pages: string[] = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        pages.push(
          content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" "),
        );
      }
      const text = pages.join("\n\n");
      return {
        text: text.trim().length === 0 ? "" : text,
        meta: { pages: String(doc.numPages) },
      };
    } finally {
      await doc.destroy();
    }
  }
}
