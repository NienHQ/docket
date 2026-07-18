/**
 * Smoke test for the PaperTrail-Bench protocol adapter
 * (scripts/bench-adapter.mjs). Drives the papertrail-protocol v1 wire
 * directly: ingest, two questions, shutdown. The full ablation matrix is
 * scripts/run-ablations.mjs, deliberately not a test.
 *
 * The adapter never sees ground truth; this TEST reads questions.jsonl to
 * pick two known questions and their expected values. Skips cleanly when
 * the sibling papertrail-bench checkout (or the built dist/) is absent, so
 * docket CI stays green without the bench repo.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BENCH = process.env["DOCKET_BENCH_DIR"] ?? join(REPO, "..", "papertrail-bench");
const FIXTURE = join(BENCH, "harness", "tests", "fixtures", "corpus-h1");
const ADAPTER = join(REPO, "scripts", "bench-adapter.mjs");
const DIST = join(REPO, "dist", "index.js");

const available = existsSync(join(FIXTURE, "messages")) && existsSync(DIST);

interface Question {
  question_id: string;
  category: number;
  template: string;
  text: string;
  answer: { type: string; value: unknown };
}

interface AnswerMsg {
  type: string;
  id: string;
  answer: unknown;
  citations: unknown;
}

/** minimal client for the newline-delimited JSON protocol */
class ProtocolClient {
  private buffer = "";
  private readonly lines: Array<Record<string, unknown>> = [];
  private waiter: (() => void) | null = null;
  private exited: Promise<number | null>;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length > 0) {
          this.lines.push(JSON.parse(line) as Record<string, unknown>);
          this.waiter?.();
        }
        idx = this.buffer.indexOf("\n");
      }
    });
    this.exited = new Promise((resolve) => {
      child.on("exit", (code) => {
        this.waiter?.();
        resolve(code);
      });
    });
  }

  send(msg: Record<string, unknown>): void {
    this.child.stdin?.write(JSON.stringify(msg) + "\n");
  }

  async next(timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (this.lines.length === 0) {
      if (Date.now() > deadline) throw new Error("timed out waiting for a protocol line");
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        setTimeout(resolve, 250);
      });
      this.waiter = null;
    }
    const line = this.lines.shift();
    if (line === undefined) throw new Error("unreachable");
    return line;
  }

  waitExit(): Promise<number | null> {
    return this.exited;
  }
}

describe("bench adapter protocol smoke", () => {
  let child: ChildProcess | null = null;

  afterAll(() => {
    if (child !== null && child.exitCode === null) child.kill("SIGKILL");
  });

  it.skipIf(!available)(
    "ingests the bench fixture, answers two questions, shuts down cleanly",
    async () => {
      const questions = readFileSync(join(FIXTURE, "questions.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Question);
      const invoiceQ = questions.find((q) => q.template === "invoice_total");
      const chainQ = questions.find((q) => q.template === "amendment_chain");
      expect(invoiceQ).toBeDefined();
      expect(chainQ).toBeDefined();
      if (invoiceQ === undefined || chainQ === undefined) return;

      child = spawn(process.execPath, [ADAPTER], {
        env: {
          ...process.env,
          DOCKET_ABL_EMBEDDER: "none",
          DOCKET_ABL_CONTEXT: "meta",
          DOCKET_ABL_LEDGER: "0",
          DOCKET_ABL_DEDUPE: "1",
        },
        stdio: ["pipe", "pipe", "inherit"],
      });
      const client = new ProtocolClient(child);

      client.send({
        type: "ingest",
        protocol: "papertrail-protocol v1",
        corpusDir: FIXTURE,
        messagesDir: join(FIXTURE, "messages"),
        attachmentsDir: join(FIXTURE, "attachments"),
      });
      const ready = await client.next(120_000);
      expect(ready["type"]).toBe("ready");

      for (const q of [invoiceQ, chainQ]) {
        client.send({
          type: "question",
          id: q.question_id,
          category: q.category,
          text: q.text,
        });
        const reply = (await client.next(60_000)) as unknown as AnswerMsg;
        expect(reply.type).toBe("answer");
        expect(reply.id).toBe(q.question_id);
        expect(Array.isArray(reply.citations)).toBe(true);
        const citations = reply.citations as unknown[];
        expect(citations.length).toBeGreaterThan(0);
        for (const c of citations) expect(typeof c).toBe("string");
        expect(reply.answer).not.toBeNull();
      }

      client.send({ type: "shutdown" });
      const code = await client.waitExit();
      expect(code).toBe(0);
    },
    180_000,
  );
});
