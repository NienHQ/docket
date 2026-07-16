#!/usr/bin/env node
// End-to-end proof that the npm tarball works, run entirely locally:
// build, pack, audit tarball contents and size, install the tarball into a
// scratch project, smoke-test the library through the installed package,
// then drive the installed docket-mcp bin over stdio.
// Usage: node scripts/verify-pack.mjs  (or: pnpm verify:pack)

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_TARBALL_BYTES = 5 * 1024 * 1024; // 5 MiB
const EXPECTED_READONLY_TOOLS = [
  "docket_hybrid_search",
  "docket_sql_filter",
  "docket_get_thread",
  "docket_get_source",
  "docket_get_entity_timeline",
  "docket_fact_as_of",
  "docket_fact_history",
  "docket_suggest_parties",
];

const tempDirs = [];
function tempDir(label) {
  const d = mkdtempSync(path.join(tmpdir(), `docket-verify-${label}-`));
  tempDirs.push(d);
  return d;
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

let failures = 0;
async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
    throw err; // steps are sequential dependencies; abort on first failure
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------- mcp client
// Minimal newline-delimited JSON-RPC client for the stdio MCP server.
function mcpSmoke(binPath, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, ["--dir", dataDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const responses = new Map();
    const timer = setTimeout(() => {
      finish(new Error(`mcp server timed out; stderr: ${stderr.trim()}`));
    }, 30_000);

    function finish(err, value) {
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (err) reject(err);
      else resolve(value);
    }

    child.on("error", (err) => finish(err));
    child.on("exit", (code) => {
      if (responses.size < 2) {
        finish(
          new Error(
            `mcp server exited early (code ${code}); stderr: ${stderr.trim()}`,
          ),
        );
      }
    });
    child.stderr.on("data", (b) => (stderr += b));
    child.stdout.on("data", (b) => {
      stdout += b;
      let nl;
      while ((nl = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        }
        if (msg.id === 2) {
          if (msg.error) {
            finish(new Error(`tools/list error: ${JSON.stringify(msg.error)}`));
          } else {
            finish(null, msg.result.tools.map((t) => t.name));
          }
        }
      }
    });

    function send(obj) {
      child.stdin.write(JSON.stringify(obj) + "\n");
    }

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "verify-pack", version: "0.0.0" },
      },
    });
  });
}

// -------------------------------------------------------------------- driver
let exitCode = 0;
try {
  let tarball;
  let entries;
  const scratch = tempDir("scratch");
  const dataDir = path.join(scratch, "archive");

  await step("pnpm build", () => {
    run("pnpm", ["build"], { cwd: root });
  });

  await step("pnpm pack", () => {
    const packDest = tempDir("pack");
    const out = run("pnpm", ["pack", "--pack-destination", packDest], {
      cwd: root,
    });
    const lines = out.trim().split("\n");
    tarball = lines[lines.length - 1].trim();
    assert(
      tarball.endsWith(".tgz") && existsSync(tarball),
      `could not locate packed tarball in pnpm output: ${out.trim()}`,
    );
    return path.basename(tarball);
  });

  await step("tarball contents: dist + metadata only", () => {
    entries = run("tar", ["-tzf", tarball])
      .trim()
      .split("\n")
      .map((e) => e.replace(/^package\//, ""));
    const allowedRoot = new Set([
      "package.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
    ]);
    const leaks = entries.filter(
      (e) => !allowedRoot.has(e) && !e.startsWith("dist/"),
    );
    assert(leaks.length === 0, `unexpected files in tarball: ${leaks.join(", ")}`);
    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/mcp/server.js",
    ]) {
      assert(entries.includes(required), `missing from tarball: ${required}`);
    }
    const firstLine = run("tar", ["-xzOf", tarball, "package/dist/mcp/server.js"])
      .split("\n")[0]
      .trim();
    assert(
      firstLine === "#!/usr/bin/env node",
      `dist/mcp/server.js lost its shebang; first line: ${firstLine}`,
    );
    return `${entries.length} files`;
  });

  await step("tarball size < 5 MiB", () => {
    const bytes = statSync(tarball).size;
    assert(
      bytes < MAX_TARBALL_BYTES,
      `tarball is ${bytes} bytes (limit ${MAX_TARBALL_BYTES})`,
    );
    return `${(bytes / 1024).toFixed(1)} KiB`;
  });

  await step("npm install tarball into scratch project", () => {
    writeFileSync(
      path.join(scratch, "package.json"),
      JSON.stringify(
        { name: "docket-scratch", version: "0.0.0", private: true, type: "module" },
        null,
        2,
      ),
    );
    // better-sqlite3 may compile from source here; give it room.
    run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball], {
      cwd: scratch,
      timeout: 480_000,
    });
    assert(
      existsSync(path.join(scratch, "node_modules", "@nienhq", "docket", "dist", "index.js")),
      "installed package is missing dist/index.js",
    );
  });

  await step("library smoke: ingest, hybridSearch, getSource", () => {
    mkdirSync(dataDir, { recursive: true });
    const smoke = `
import { Docket } from "@nienhq/docket";

const dir = process.argv[2];
const eml = new TextEncoder().encode(
  [
    "Message-ID: <verify-1@northgate.example>",
    "From: Alice Chen <alice@northgate.example>",
    "To: billing@acme.example",
    "Subject: payment terms update",
    "Date: Wed, 01 May 2024 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Confirming that payment terms move to NET45 effective July 2024.",
    "",
  ].join("\\r\\n"),
);

const dk = await Docket.open(dir);
const res = await dk.ingest.emlBytes(eml);
if (!res) throw new Error("ingest returned nothing");
const hits = await dk.tools.hybridSearch({ query: "payment terms NET45", k: 5 });
if (hits.length === 0) throw new Error("hybridSearch found nothing");
if (!hits[0].text.includes("NET45")) throw new Error("top hit does not contain NET45");
const src = dk.tools.getSource(hits[0].chunkId);
if (!src) throw new Error("getSource did not resolve the citation");
if (!(src.raw && src.raw.length > 0)) throw new Error("getSource returned empty raw bytes");
dk.close();
console.log("smoke-ok " + hits[0].chunkId);
`;
    const smokePath = path.join(scratch, "smoke.mjs");
    writeFileSync(smokePath, smoke);
    const out = run(process.execPath, [smokePath, dataDir], { cwd: scratch });
    assert(out.includes("smoke-ok"), `smoke script output: ${out.trim()}`);
    return out.trim();
  });

  await step("installed docket-mcp bin: initialize + tools/list", async () => {
    const binPath = path.join(scratch, "node_modules", ".bin", "docket-mcp");
    assert(existsSync(binPath), "npm did not create node_modules/.bin/docket-mcp");
    const tools = await mcpSmoke(binPath, dataDir);
    assert(
      tools.length === EXPECTED_READONLY_TOOLS.length,
      `expected ${EXPECTED_READONLY_TOOLS.length} tools, got ${tools.length}: ${tools.join(", ")}`,
    );
    for (const name of EXPECTED_READONLY_TOOLS) {
      assert(tools.includes(name), `missing tool: ${name}`);
    }
    return tools.length + " tools";
  });

  console.log("\nverify:pack PASS");
} catch {
  exitCode = 1;
  console.error("\nverify:pack FAIL");
} finally {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
process.exit(exitCode || (failures > 0 ? 1 : 0));
