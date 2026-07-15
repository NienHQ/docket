/**
 * Embedder adapters (plan 2.2): OpenAiEmbedder against a local mock HTTP
 * server (no network), reembed() semantics on the facade, and LocalEmbedder.
 * The real transformers.js model test only runs when DOCKET_LOCAL_EMBEDDER=1
 * is set (it downloads a model); CI does not set the flag.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import DatabaseCtor from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Docket } from "../src/docket.js";
import { HashEmbedder, LocalEmbedder, OpenAiEmbedder } from "../src/embedders/index.js";
import type { Embedder } from "../src/types.js";

const MESSAGES_DIR = fileURLToPath(
  new URL("./fixtures/corpus-small/messages", import.meta.url),
);

// ------------------------------------------------------------- mock server

interface SeenRequest {
  input: string[];
  model: string;
  encodingFormat: string;
  authorization: string | undefined;
}

interface MockReply {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

interface MockServer {
  url: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

/** replies[i] answers request i; the last entry repeats for any overflow */
async function startMockServer(
  replies: Array<(req: SeenRequest) => MockReply>,
): Promise<MockServer> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        input: string[];
        model: string;
        encoding_format: string;
      };
      const record: SeenRequest = {
        input: parsed.input,
        model: parsed.model,
        encodingFormat: parsed.encoding_format,
        authorization: req.headers.authorization,
      };
      const make = replies[Math.min(seen.length, replies.length - 1)];
      seen.push(record);
      if (!make) throw new Error("mock server has no reply configured");
      const reply = make(record);
      res.writeHead(reply.status, {
        "content-type": "application/json",
        ...reply.headers,
      });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no server address");
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** each input text "<n>" maps to the vector [n, 0, 0, 0]; data comes back reversed */
function okReply(dim: number): (req: SeenRequest) => MockReply {
  return (req) => {
    const data = req.input.map((text, index) => {
      const embedding = new Array<number>(dim).fill(0);
      embedding[0] = Number(text);
      return { index, embedding, object: "embedding" };
    });
    data.reverse(); // client must reorder by the index field
    return { status: 200, body: JSON.stringify({ object: "list", data }) };
  };
}

// ------------------------------------------------------------ test helpers

/** same vectors as HashEmbedder, stored under a different model id */
class HashEmbedderB implements Embedder {
  readonly model = "hash-64-b";
  readonly dim = 64;
  private readonly inner = new HashEmbedder();
  embed(texts: string[]): Promise<Float32Array[]> {
    return this.inner.embed(texts);
  }
}

function fixtureFiles(n: number): string[] {
  return readdirSync(MESSAGES_DIR)
    .filter((f) => f.endsWith(".eml"))
    .sort()
    .slice(0, n)
    .map((f) => join(MESSAGES_DIR, f));
}

function countRows(dir: string, sql: string): number {
  const db = new DatabaseCtor(join(dir, "docket.db"), { readonly: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ------------------------------------------------------------------- tests

describe("OpenAiEmbedder", () => {
  let mock: MockServer | undefined;

  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  it("splits 150 texts into 3 sequential batches and maps responses by index", async () => {
    mock = await startMockServer([okReply(4)]);
    const embedder = new OpenAiEmbedder({
      model: "test-embed",
      dim: 4,
      apiKey: "sk-test",
      baseUrl: mock.url,
      batchSize: 64,
    });
    const texts = Array.from({ length: 150 }, (_, i) => String(i));
    const vectors = await embedder.embed(texts);

    expect(mock.seen.length).toBe(3);
    expect(mock.seen.map((r) => r.input.length)).toEqual([64, 64, 22]);
    expect(mock.seen[0]?.model).toBe("test-embed");
    expect(mock.seen[0]?.encodingFormat).toBe("float");
    expect(mock.seen[0]?.authorization).toBe("Bearer sk-test");
    expect(mock.seen[0]?.input[0]).toBe("0");
    expect(mock.seen[2]?.input[0]).toBe("128");

    expect(vectors.length).toBe(150);
    // the mock reverses each data array, so order proves index-based mapping
    vectors.forEach((v, i) => {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(4);
      expect(v[0]).toBe(i);
    });
  });

  it("omits the Authorization header when no apiKey is given", async () => {
    mock = await startMockServer([okReply(4)]);
    const embedder = new OpenAiEmbedder({ model: "m", dim: 4, baseUrl: mock.url });
    await embedder.embed(["1"]);
    expect(mock.seen[0]?.authorization).toBeUndefined();
  });

  it("throws a descriptive error on dim mismatch", async () => {
    mock = await startMockServer([okReply(3)]); // server returns dim 3
    const embedder = new OpenAiEmbedder({ model: "m", dim: 4, baseUrl: mock.url });
    await expect(embedder.embed(["1"])).rejects.toThrow(/dim 3, expected 4/);
  });

  it("throws immediately on 400 with a body snippet, no retry", async () => {
    mock = await startMockServer([
      () => ({
        status: 400,
        body: JSON.stringify({ error: { message: "unknown model zork" } }),
      }),
    ]);
    const embedder = new OpenAiEmbedder({ model: "m", dim: 4, baseUrl: mock.url });
    await expect(embedder.embed(["1"])).rejects.toThrow(/status 400.*unknown model zork/);
    expect(mock.seen.length).toBe(1);
  });

  it("retries a 429 (honoring Retry-After: 0) and succeeds", async () => {
    mock = await startMockServer([
      () => ({
        status: 429,
        headers: { "retry-after": "0" },
        body: JSON.stringify({ error: { message: "rate limited" } }),
      }),
      okReply(4),
    ]);
    const embedder = new OpenAiEmbedder({ model: "m", dim: 4, baseUrl: mock.url });
    const vectors = await embedder.embed(["7"]);
    expect(mock.seen.length).toBe(2);
    expect(vectors[0]?.[0]).toBe(7);
  });

  it("exhausts maxRetries on persistent 500 and reports the status", async () => {
    mock = await startMockServer([
      () => ({
        status: 500,
        headers: { "retry-after": "0" },
        body: JSON.stringify({ error: { message: "boom" } }),
      }),
    ]);
    const embedder = new OpenAiEmbedder({
      model: "m",
      dim: 4,
      baseUrl: mock.url,
      maxRetries: 1,
    });
    await expect(embedder.embed(["1"])).rejects.toThrow(/status 500.*2 attempt/);
    expect(mock.seen.length).toBe(2); // initial attempt + 1 retry
  });
});

describe("reembed", () => {
  let dir: string;
  const open: Docket[] = [];

  async function openDocket(options?: Parameters<typeof Docket.open>[1]): Promise<Docket> {
    const dk = await Docket.open(dir, options ?? {});
    open.push(dk);
    return dk;
  }

  afterEach(() => {
    for (const dk of open.splice(0)) {
      try {
        dk.close();
      } catch {
        // already closed
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("fills missing vectors per model, is idempotent, and keeps other models' rows", async () => {
    dir = mkdtempSync(join(tmpdir(), "docket-reembed-"));

    // ingest with NO embedder: chunks exist, embeddings table stays empty
    let dk = await openDocket();
    for (const f of fixtureFiles(5)) await dk.ingest.emlFile(f);
    dk.close();
    const chunkCount = countRows(dir, "SELECT count(*) AS n FROM chunks");
    expect(chunkCount).toBeGreaterThan(0);
    expect(countRows(dir, "SELECT count(*) AS n FROM embeddings")).toBe(0);

    // same dir, now with an embedder: reembed fills every chunk
    dk = await openDocket({ embedder: new HashEmbedder() });
    const first = await dk.reembed();
    expect(first.embedded).toBe(chunkCount);
    const second = await dk.reembed();
    expect(second.embedded).toBe(0);

    expect(
      countRows(dir, "SELECT count(*) AS n FROM embeddings WHERE model = 'hash-64'"),
    ).toBe(chunkCount);
    expect(countRows(dir, "SELECT count(*) AS n FROM embeddings")).toBe(chunkCount);

    // the vector path participates now: hits exist and are deterministic
    const q = { query: "invoice payment", k: 5 };
    const hitsA = await dk.tools.hybridSearch(q);
    const hitsB = await dk.tools.hybridSearch(q);
    expect(hitsA.length).toBeGreaterThan(0);
    expect(hitsB).toEqual(hitsA);
    dk.close();

    // switching models reembeds every chunk under the new model id without a
    // full reindex. Since schema v4 the embeddings PK is (chunk_id, model),
    // so both models' vectors coexist and search picks by configured model.
    dk = await openDocket({ embedder: new HashEmbedderB() });
    const third = await dk.reembed();
    expect(third.embedded).toBe(chunkCount);
    dk.close();
    expect(
      countRows(dir, "SELECT count(*) AS n FROM embeddings WHERE model = 'hash-64-b'"),
    ).toBe(chunkCount);
    expect(
      countRows(dir, "SELECT count(*) AS n FROM embeddings WHERE model = 'hash-64'"),
    ).toBe(chunkCount);
    expect(countRows(dir, "SELECT count(*) AS n FROM embeddings")).toBe(chunkCount * 2);
  });

  it("rejects with a clear error when no embedder is configured", async () => {
    dir = mkdtempSync(join(tmpdir(), "docket-reembed-"));
    const dk = await openDocket();
    await expect(dk.reembed()).rejects.toThrow(/reembed requires an embedder/);
  });

  it("rejects on a readonly instance", async () => {
    dir = mkdtempSync(join(tmpdir(), "docket-reembed-"));
    const writer = await openDocket();
    writer.close();
    const reader = await openDocket({ readonly: true, embedder: new HashEmbedder() });
    await expect(reader.reembed()).rejects.toThrow(/read-only/);
  });
});

const hfInstalled = await (async () => {
  try {
    const specifier = "@huggingface/transformers";
    await import(specifier);
    return true;
  } catch {
    return false;
  }
})();

describe("LocalEmbedder", () => {

  it.runIf(!hfInstalled)(
    "throws a clear error when the optional peer is absent",
    async () => {
      const embedder = new LocalEmbedder();
      await expect(embedder.embed(["hello"])).rejects.toThrow(
        "@huggingface/transformers is not installed; add it to use LocalEmbedder" +
          " (optional peer dependency)",
      );
      expect(embedder.model).toBe("Xenova/all-MiniLM-L6-v2");
      expect(embedder.dim).toBe(384);
    },
  );

  // downloads a real model: only runs with DOCKET_LOCAL_EMBEDDER=1 (never in CI)
  it.runIf(process.env.DOCKET_LOCAL_EMBEDDER === "1")(
    "embeds real sentences with sensible cosine structure",
    async () => {
      const embedder = new LocalEmbedder();
      const [invoice, bill, picnic] = await embedder.embed([
        "The invoice payment is overdue and must be settled this week.",
        "Please pay the outstanding bill before the end of the week.",
        "The company picnic is on Saturday in the park.",
      ]);
      expect(invoice?.length).toBe(384);
      expect(bill?.length).toBe(384);
      expect(picnic?.length).toBe(384);
      if (!invoice || !bill || !picnic) throw new Error("missing vectors");
      expect(cosine(invoice, bill)).toBeGreaterThan(cosine(invoice, picnic));
    },
    180_000,
  );
});
