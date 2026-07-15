/**
 * Stdio MCP server exposing one Docket directory to MCP clients.
 * Start: node dist/mcp/server.js --dir <path>
 */
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

export async function startServer(dir: string): Promise<void> {
  const dk = await Docket.open(dir);
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const dirFlag = process.argv.indexOf("--dir");
if (import.meta.url === `file://${process.argv[1]}`) {
  if (dirFlag === -1 || !process.argv[dirFlag + 1]) {
    console.error("usage: node dist/mcp/server.js --dir <path>");
    process.exit(1);
  }
  startServer(process.argv[dirFlag + 1] as string).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
