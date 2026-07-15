#!/usr/bin/env node
/**
 * Stdio MCP server exposing one Docket directory to MCP clients.
 * Start: docket-mcp --dir <path> [--write | --readonly]
 * (or: node dist/mcp/server.js --dir <path> [--write | --readonly])
 *
 * The server opens the directory read-only by default (many readers may
 * coexist with one writer, per the concurrency contract in docs/spec.md
 * section 2). Pass --write to open a writer and register the fact and
 * entity write tools.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Docket } from "../docket.js";

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

export interface ServerOptions {
  /** open a writer and register the write tools; default is read-only */
  write?: boolean;
}

export async function startServer(dir: string, opts: ServerOptions = {}): Promise<void> {
  const write = opts.write === true;
  const dk = await Docket.open(dir, { readonly: !write });
  const server = new McpServer({ name: "docket", version: "0.1.0" });

  server.registerTool(
    "docket_hybrid_search",
    {
      description:
        "Search the mail archive (BM25 + optional vectors, reranked). " +
        "Returns chunks with citation ids resolvable via docket_get_source.",
      inputSchema: {
        query: z.string(),
        k: z.number().int().min(1).max(50).optional(),
        fromAddress: z.string().optional(),
        partyId: z.string().optional(),
        threadId: z.string().optional(),
        after: z.string().optional(),
        before: z.string().optional(),
        sourceKind: z.enum(["message", "attachment"]).optional(),
        mime: z.string().optional(),
      },
    },
    async ({ query, k, fromAddress, partyId, threadId, after, before, sourceKind, mime }) => {
      const hits = await dk.tools.hybridSearch({
        query,
        ...(k !== undefined ? { k } : {}),
        filter: {
          ...(fromAddress !== undefined ? { fromAddress } : {}),
          ...(partyId !== undefined ? { partyId } : {}),
          ...(threadId !== undefined ? { threadId } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(before !== undefined ? { before } : {}),
          ...(sourceKind !== undefined ? { sourceKind } : {}),
          ...(mime !== undefined ? { mime } : {}),
        },
      });
      return text(hits.map(({ features, ...h }) => h));
    },
  );

  server.registerTool(
    "docket_sql_filter",
    {
      description:
        "Structured filter over messages, threads, documents, facts, " +
        "attachments or parties. No raw SQL.",
      inputSchema: {
        table: z.enum(["messages", "threads", "documents", "facts", "attachments", "parties"]),
        where: z
          .array(
            z.object({
              column: z.string(),
              op: z.enum(["=", "!=", "<", "<=", ">", ">=", "like"]),
              value: z.union([z.string(), z.number()]),
            }),
          )
          .optional(),
        orderBy: z
          .object({ column: z.string(), dir: z.enum(["asc", "desc"]) })
          .optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ table, where, orderBy, limit }) =>
      text(
        dk.tools.sqlFilter({
          table,
          ...(where !== undefined ? { where } : {}),
          ...(orderBy !== undefined ? { orderBy } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "docket_get_thread",
    {
      description: "Full thread by id: ordered messages, stripped text, attachments.",
      inputSchema: { threadId: z.string() },
    },
    async ({ threadId }) => text(dk.tools.getThread(threadId) ?? "thread not found"),
  );

  server.registerTool(
    "docket_get_source",
    {
      description:
        "Resolve a chunk citation to its frozen source: exact text span, " +
        "blob hash, mime, message id.",
      inputSchema: { chunkId: z.string() },
    },
    async ({ chunkId }) => {
      const src = dk.tools.getSource(chunkId);
      if (!src) return text("chunk not found");
      const { raw, ...meta } = src;
      return text({ ...meta, rawBytes: raw.length });
    },
  );

  server.registerTool(
    "docket_get_entity_timeline",
    {
      description: "Chronological facts, documents and messages for a party.",
      inputSchema: {
        partyId: z.string(),
        after: z.string().optional(),
        before: z.string().optional(),
      },
    },
    async ({ partyId, after, before }) =>
      text(
        dk.tools.getEntityTimeline(partyId, {
          ...(after !== undefined ? { after } : {}),
          ...(before !== undefined ? { before } : {}),
        }),
      ),
  );

  server.registerTool(
    "docket_fact_as_of",
    {
      description: "Point-in-time fact lookup: value of (entity, relation) as of a date.",
      inputSchema: { entity: z.string(), relation: z.string(), date: z.string() },
    },
    async ({ entity, relation, date }) =>
      text(dk.facts.asOf(entity, relation, date) ?? "no fact valid at that date"),
  );

  server.registerTool(
    "docket_fact_history",
    {
      description:
        "Full belief history for (entity, relation), including superseded facts.",
      inputSchema: { entity: z.string(), relation: z.string() },
    },
    async ({ entity, relation }) => text(dk.facts.history(entity, relation)),
  );

  if (write) {
    server.registerTool(
      "docket_fact_assert",
      {
        description:
          "Assert a bi-temporal fact for (entity, relation). Requires a " +
          "source citation: sourceChunk or sourceMessage. Returns the created row.",
        inputSchema: {
          entity: z.string(),
          relation: z.string(),
          value: z.string(),
          validFrom: z.string().describe("ISO date, event time"),
          sourceChunk: z.string().optional(),
          sourceMessage: z.string().optional(),
        },
      },
      async ({ entity, relation, value, validFrom, sourceChunk, sourceMessage }) => {
        if (sourceChunk === undefined && sourceMessage === undefined) {
          return text("error: provide sourceChunk or sourceMessage (at least one)");
        }
        const row = dk.facts.assert({
          entity,
          relation,
          value,
          validFrom,
          source: {
            ...(sourceChunk !== undefined ? { chunkId: sourceChunk } : {}),
            ...(sourceMessage !== undefined ? { messageId: sourceMessage } : {}),
          },
        });
        return text(row);
      },
    );

    server.registerTool(
      "docket_entity_map",
      {
        description:
          "Upsert a party and map an email address to it, optionally with a " +
          "validity window.",
        inputSchema: {
          partyId: z.string(),
          name: z.string(),
          kind: z.string().optional().describe("default: company"),
          address: z.string(),
          person: z.string().optional(),
          fromDate: z.string().optional(),
          toDate: z.string().optional(),
        },
      },
      async ({ partyId, name, kind, address, person, fromDate, toDate }) => {
        dk.entities.addParty({ partyId, name, kind: kind ?? "company" });
        dk.entities.mapAddress({
          address,
          partyId,
          ...(person !== undefined ? { person } : {}),
          ...(fromDate !== undefined ? { fromDate } : {}),
          ...(toDate !== undefined ? { toDate } : {}),
        });
        return text({ ok: true, partyId, address });
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Main-module check that survives npm bin symlinks: node realpaths the main
// module (so import.meta.url is the real file) while argv[1] stays the symlink.
function invokedAsMain(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  const argv = process.argv;
  const dirFlag = argv.indexOf("--dir");
  const write = argv.includes("--write");
  const readonlyFlag = argv.includes("--readonly"); // explicit no-op: readonly is the default
  const usage = "usage: docket-mcp --dir <path> [--write | --readonly]";
  if (dirFlag === -1 || !argv[dirFlag + 1] || (write && readonlyFlag)) {
    console.error(usage);
    process.exit(1);
  }
  startServer(argv[dirFlag + 1] as string, { write }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    if (!write) {
      console.error(
        "hint: the server opens read-only by default, so the database must " +
          "already exist at the current schema version; open a writer once " +
          "(Docket.open without readonly, or --write) to create or migrate it",
      );
    }
    process.exit(1);
  });
}
