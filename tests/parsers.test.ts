import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Docket } from "../src/docket.js";
import { PdfTextParser } from "../src/parsers/pdf.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "pdf");
const invoicePdf = new Uint8Array(readFileSync(join(FIXTURES, "invoice.pdf")));
const scannedPdf = new Uint8Array(readFileSync(join(FIXTURES, "scanned.pdf")));

function makePdfEml(opts: {
  messageId: string;
  subject: string;
  filename: string;
  pdfBytes: Uint8Array;
}): Uint8Array {
  const b = "docket-pdf-boundary";
  const b64 = Buffer.from(opts.pdfBytes).toString("base64");
  const b64Lines = b64.match(/.{1,76}/g)?.join("\r\n") ?? "";
  const lines = [
    `Message-ID: <${opts.messageId}>`,
    "From: Alice Vendor <alice@vendor.test>",
    "To: bob@customer.test",
    `Subject: ${opts.subject}`,
    "Date: Wed, 08 Jul 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Please find the document attached.",
    `--${b}`,
    `Content-Type: application/pdf; name="${opts.filename}"`,
    `Content-Disposition: attachment; filename="${opts.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines,
    `--${b}--`,
    "",
  ];
  return new TextEncoder().encode(lines.join("\r\n"));
}

class CountingPdfParser extends PdfTextParser {
  calls = 0;
  override async parse(bytes: Uint8Array): Promise<{ text: string; meta?: Record<string, string> }> {
    this.calls++;
    return super.parse(bytes);
  }
}

class CountingPdfParserV2 extends CountingPdfParser {
  override readonly version: string = "2";
}

interface ChunkRow {
  chunk_id: string;
  span_start: number;
  span_end: number;
  text: string;
  meta_json: string;
}

interface CacheRow {
  tool: string;
  tool_version: string;
  text: string;
  meta_json: string;
}

describe("attachment parsers (PDF)", () => {
  let dir: string;
  let dk: Docket | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docket-parsers-"));
    dk = null;
  });

  afterEach(() => {
    dk?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** second connection for derived-table assertions; WAL allows this in-process */
  function raw<T>(fn: (db: Database.Database) => T): T {
    const db = new Database(join(dir, "docket.db"), { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function attachmentBlobHash(): string {
    return raw((db) => {
      const row = db
        .prepare("SELECT blob_hash FROM attachments ORDER BY message_id LIMIT 1")
        .get() as { blob_hash: string } | undefined;
      if (!row) throw new Error("no attachment row");
      return row.blob_hash;
    });
  }

  function chunksFor(blobHash: string): ChunkRow[] {
    return raw((db) =>
      db
        .prepare(
          "SELECT chunk_id, span_start, span_end, text, meta_json FROM chunks" +
            " WHERE blob_hash = ? ORDER BY chunk_id",
        )
        .all(blobHash) as ChunkRow[],
    );
  }

  function cacheFor(blobHash: string): CacheRow[] {
    return raw((db) =>
      db
        .prepare(
          "SELECT tool, tool_version, text, meta_json FROM parse_cache" +
            " WHERE blob_hash = ? ORDER BY tool_version",
        )
        .all(blobHash) as CacheRow[],
    );
  }

  it("indexes a PDF attachment: search hits, source resolution, parser meta", async () => {
    dk = await Docket.open(dir, { parsers: [new PdfTextParser()] });
    await dk.ingest.emlBytes(
      makePdfEml({
        messageId: "pdf1@vendor.test",
        subject: "Document attached",
        filename: "invoice.pdf",
        pdfBytes: invoicePdf,
      }),
    );

    for (const query of ["INV-2099-0001", "payment terms NET 45"]) {
      const hits = await dk.tools.hybridSearch({
        query,
        filter: { sourceKind: "attachment" },
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.text).toContain("INV-2099-0001");
      const src = dk.tools.getSource(hits[0]?.chunkId ?? "");
      expect(src).not.toBeNull();
      expect(src?.mime).toBe("application/pdf");
      expect(Buffer.from(src?.raw ?? []).equals(Buffer.from(invoicePdf))).toBe(true);
    }

    const blobHash = attachmentBlobHash();
    const chunks = chunksFor(blobHash);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      const meta = JSON.parse(c.meta_json) as Record<string, string>;
      expect(meta["parser"]).toBe("pdf-text");
      expect(meta["parserVersion"]).toBe("1");
      expect(meta["filename"]).toBe("invoice.pdf");
    }
    const cache = cacheFor(blobHash);
    expect(cache.length).toBe(1);
    expect(cache[0]?.tool).toBe("pdf-text");
    expect(JSON.parse(cache[0]?.meta_json ?? "{}")).toEqual({ pages: "1" });
  });

  it("reindex reuses parse_cache: no second parse, identical chunks", async () => {
    const parser = new CountingPdfParser();
    dk = await Docket.open(dir, { parsers: [parser] });
    await dk.ingest.emlBytes(
      makePdfEml({
        messageId: "pdf2@vendor.test",
        subject: "Document attached",
        filename: "invoice.pdf",
        pdfBytes: invoicePdf,
      }),
    );
    expect(parser.calls).toBe(1);

    const blobHash = attachmentBlobHash();
    const before = chunksFor(blobHash);
    expect(before.length).toBeGreaterThan(0);

    await dk.reindex();
    expect(parser.calls).toBe(1); // cache hit, parser untouched
    expect(chunksFor(blobHash)).toEqual(before); // ids and spans stable
  });

  it("parser version bump invalidates the cache on reindex", async () => {
    dk = await Docket.open(dir, { parsers: [new PdfTextParser()] });
    await dk.ingest.emlBytes(
      makePdfEml({
        messageId: "pdf3@vendor.test",
        subject: "Document attached",
        filename: "invoice.pdf",
        pdfBytes: invoicePdf,
      }),
    );
    const blobHash = attachmentBlobHash();
    dk.close();

    const v2 = new CountingPdfParserV2();
    dk = await Docket.open(dir, { parsers: [v2] });
    await dk.reindex();
    expect(v2.calls).toBe(1); // v2 has no cache row yet, so it re-parses

    const cache = cacheFor(blobHash);
    expect(cache.map((r) => r.tool_version)).toEqual(["1", "2"]);
    const chunks = chunksFor(blobHash);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect((JSON.parse(c.meta_json) as Record<string, string>)["parserVersion"]).toBe("2");
    }
  });

  it("scanned PDF (no text layer): empty text cached once, no chunks", async () => {
    const parser = new CountingPdfParser();
    dk = await Docket.open(dir, { parsers: [parser] });
    await dk.ingest.emlBytes(
      makePdfEml({
        messageId: "pdf4@vendor.test",
        subject: "Scan attached",
        filename: "scanned.pdf",
        pdfBytes: scannedPdf,
      }),
    );
    expect(parser.calls).toBe(1);

    const blobHash = attachmentBlobHash();
    expect(chunksFor(blobHash)).toEqual([]);
    const cache = cacheFor(blobHash);
    expect(cache.length).toBe(1);
    expect(cache[0]?.text).toBe("");

    await dk.reindex();
    expect(parser.calls).toBe(1); // the empty result is cached, never re-parsed
    expect(chunksFor(blobHash)).toEqual([]);
  });

  it("malformed PDF bytes: ingest and reindex survive, nothing cached", async () => {
    dk = await Docket.open(dir, { parsers: [new PdfTextParser()] });
    const garbage = new TextEncoder().encode("this is not a pdf at all, just junk bytes");
    const r = await dk.ingest.emlBytes(
      makePdfEml({
        messageId: "pdf5@vendor.test",
        subject: "Broken attachment",
        filename: "broken.pdf",
        pdfBytes: garbage,
      }),
    );
    expect(r.attachments).toBe(1);

    const blobHash = attachmentBlobHash();
    expect(chunksFor(blobHash)).toEqual([]);
    expect(cacheFor(blobHash)).toEqual([]);

    await dk.reindex(); // must not throw either
    expect(chunksFor(blobHash)).toEqual([]);
    expect(cacheFor(blobHash)).toEqual([]);
  });

  it("without a configured parser the PDF stays unindexed", async () => {
    dk = await Docket.open(dir);
    await dk.ingest.emlBytes(
      makePdfEml({
        messageId: "pdf6@vendor.test",
        subject: "Document attached",
        filename: "invoice.pdf",
        pdfBytes: invoicePdf,
      }),
    );
    const blobHash = attachmentBlobHash();
    expect(chunksFor(blobHash)).toEqual([]);
    expect(cacheFor(blobHash)).toEqual([]);
    const hits = await dk.tools.hybridSearch({ query: "INV-2099-0001" });
    expect(hits.length).toBe(0);
  });

  it("tombstone purges parse_cache rows along with chunks", async () => {
    dk = await Docket.open(dir, { parsers: [new PdfTextParser()] });
    await dk.ingest.emlBytes(
      makePdfEml({
        messageId: "pdf7@vendor.test",
        subject: "Document attached",
        filename: "invoice.pdf",
        pdfBytes: invoicePdf,
      }),
    );
    const blobHash = attachmentBlobHash();
    expect(chunksFor(blobHash).length).toBeGreaterThan(0);
    expect(cacheFor(blobHash).length).toBe(1);

    dk.store.tombstone(blobHash, "erasure request");

    expect(chunksFor(blobHash)).toEqual([]);
    expect(cacheFor(blobHash)).toEqual([]);
    const audit = raw((db) =>
      db
        .prepare("SELECT action, subject FROM audit_log WHERE subject = ?")
        .all(blobHash) as Array<{ action: string; subject: string }>,
    );
    expect(audit).toEqual([{ action: "tombstone", subject: blobHash }]);
  });
});
