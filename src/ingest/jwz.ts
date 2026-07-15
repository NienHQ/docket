import type { Database } from "better-sqlite3";
import { sha256Hex } from "./eml.js";

interface MsgRow {
  message_id: string;
  subject: string;
  sent_at: string | null;
  in_reply_to: string | null;
  references_json: string;
}

interface ClusterRow extends MsgRow {
  thread_id: string | null;
}

interface Container {
  id: string;
  parent: Container | null;
  children: Set<Container>;
}

interface Group {
  rootId: string;
  members: string[];
}

export interface RethreadStats {
  /** Messages included in the recomputed cluster. */
  clusterSize: number;
  /** Messages whose stored thread_id actually changed value. */
  rewritten: number;
}

export function stripSubjectPrefixes(subject: string): string {
  let out = subject.trim();
  const re = /^(re|fwd?|fw)\s*:\s*/i;
  while (re.test(out)) out = out.replace(re, "").trim();
  return out;
}

export function normalizeSubject(subject: string): string {
  return stripSubjectPrefixes(subject).toLowerCase();
}

export function threadIdForRoot(rootMessageId: string): string {
  return `thr_${sha256Hex(rootMessageId).slice(0, 16)}`;
}

function refsOf(row: MsgRow): string[] {
  return (JSON.parse(row.references_json) as string[]).filter(
    (r) => r.length > 0 && r !== row.message_id,
  );
}

/**
 * JWZ container pass plus subject fallback over a set of message rows.
 * Rows must be sorted by message_id (the caller guarantees it); the result
 * depends only on the row set, never on ingest order. When the input is a
 * union of complete link-connected components that is also closed under
 * subject-fallback interaction, the output equals the corresponding slice
 * of a full recompute.
 */
function computeGroups(rows: MsgRow[]): { groups: Group[]; byId: Map<string, MsgRow> } {
  const byId = new Map<string, MsgRow>();
  for (const row of rows) byId.set(row.message_id, row);

  const containers = new Map<string, Container>();
  const get = (id: string): Container => {
    let c = containers.get(id);
    if (!c) {
      c = { id, parent: null, children: new Set() };
      containers.set(id, c);
    }
    return c;
  };
  const isAncestor = (anc: Container, node: Container): boolean => {
    for (let p: Container | null = node; p; p = p.parent) if (p === anc) return true;
    return false;
  };
  const setParent = (child: Container, parent: Container): void => {
    // refuse self-parenting and anything that would close a cycle
    if (child === parent || isAncestor(child, parent)) return;
    if (child.parent) child.parent.children.delete(child);
    child.parent = parent;
    parent.children.add(child);
  };

  for (const row of rows) {
    const refs = refsOf(row);
    let prev: Container | null = null;
    for (const ref of refs) {
      const c = get(ref);
      if (prev && c.parent === null) setParent(c, prev);
      prev = c;
    }
    const self = get(row.message_id);
    const parentId =
      refs.length > 0 ? refs[refs.length - 1]! : row.in_reply_to !== row.message_id ? row.in_reply_to : null;
    if (parentId) setParent(self, get(parentId));
  }

  const sortKey = (id: string): string => {
    const row = byId.get(id)!;
    return `${row.sent_at ?? "\uffff"} ${id}`;
  };
  const earliestMember = (g: Group): string =>
    g.members.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))[0]!;

  const groups: Group[] = [];
  for (const c of containers.values()) {
    if (c.parent) continue;
    const members: string[] = [];
    const stack: Container[] = [c];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (byId.has(cur.id)) members.push(cur.id);
      for (const child of cur.children) stack.push(child);
    }
    if (members.length > 0) groups.push({ rootId: c.id, members: members.sort() });
  }

  // subject fallback: header-linkless singletons join a thread whose
  // normalized subject matches; matching linkless singletons merge together
  const hasHeaderLinks = (id: string): boolean => {
    const row = byId.get(id)!;
    return refsOf(row).length > 0 || (row.in_reply_to !== null && row.in_reply_to !== id);
  };
  const isLoner = (g: Group): boolean =>
    g.members.length === 1 && g.members[0] === g.rootId && !hasHeaderLinks(g.rootId);
  const groupSubject = (g: Group): string => {
    const rootRow = byId.get(g.rootId);
    const row = rootRow ?? byId.get(earliestMember(g))!;
    return normalizeSubject(row.subject);
  };

  const buckets = new Map<string, Group[]>();
  for (const g of groups) {
    const s = groupSubject(g);
    if (s === "") continue;
    const bucket = buckets.get(s);
    if (bucket) bucket.push(g);
    else buckets.set(s, [g]);
  }

  const consumed = new Set<Group>();
  const mergedGroups: Group[] = [];
  for (const bucket of buckets.values()) {
    const loners = bucket.filter(isLoner);
    if (loners.length === 0) continue;
    const anchors = bucket.filter((g) => !isLoner(g));
    if (anchors.length > 0) {
      const anchor = anchors.slice().sort((a, b) => (a.rootId < b.rootId ? -1 : 1))[0]!;
      for (const l of loners) {
        anchor.members.push(...l.members);
        consumed.add(l);
      }
    } else if (loners.length > 1) {
      const members = loners.flatMap((l) => l.members);
      const rootId = members.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))[0]!;
      mergedGroups.push({ rootId, members });
      for (const l of loners) consumed.add(l);
    }
  }
  return { groups: groups.filter((g) => !consumed.has(g)).concat(mergedGroups), byId };
}

interface ThreadRow {
  threadId: string;
  subject: string;
  firstAt: string | null;
  lastAt: string | null;
}

function threadRowFor(g: Group, byId: Map<string, MsgRow>): ThreadRow {
  const sortKey = (id: string): string => {
    const row = byId.get(id)!;
    return `${row.sent_at ?? "\uffff"} ${id}`;
  };
  const earliest = g.members.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))[0]!;
  const subjectRow = byId.get(g.rootId) ?? byId.get(earliest)!;
  const dates = g.members
    .map((m) => byId.get(m)!.sent_at)
    .filter((d): d is string => d !== null)
    .sort();
  return {
    threadId: threadIdForRoot(g.rootId),
    subject: stripSubjectPrefixes(subjectRow.subject),
    firstAt: dates[0] ?? null,
    lastAt: dates[dates.length - 1] ?? null,
  };
}

/**
 * JWZ reconciliation over headers stored in the database, recomputed from
 * scratch: the result depends only on the set of stored messages, never on
 * ingest order. Rows are processed in message_id order for determinism.
 */
export function rethreadAll(db: Database): void {
  const rows = db
    .prepare(
      "SELECT message_id, subject, sent_at, in_reply_to, references_json FROM messages ORDER BY message_id",
    )
    .all() as MsgRow[];

  const { groups, byId } = computeGroups(rows);

  const updateMsg = db.prepare("UPDATE messages SET thread_id = ? WHERE message_id = ?");
  const insertThread = db.prepare(
    "INSERT INTO threads (thread_id, subject, first_at, last_at) VALUES (?, ?, ?, ?)",
  );
  db.transaction(() => {
    db.prepare("DELETE FROM threads").run();
    for (const g of groups) {
      const t = threadRowFor(g, byId);
      insertThread.run(t.threadId, t.subject, t.firstAt, t.lastAt);
      for (const m of g.members) updateMsg.run(t.threadId, m);
    }
  })();
}

const CLUSTER_COLS = "message_id, thread_id, subject, sent_at, in_reply_to, references_json";

/**
 * Incremental JWZ update after inserting or replacing one message. Instead
 * of rethreading the whole archive, it gathers the affected cluster and
 * runs the same container algorithm over just those rows:
 *
 * 1. Link closure: BFS over the id graph (a message mentions its own id,
 *    its References and its In-Reply-To; placeholder ids connect messages
 *    that share them), seeded from the target message.
 * 2. Thread completion: every thread touched is pulled in whole, so
 *    subject-absorbed loners move with their thread.
 * 3. Subject fallback closure: for every normalized subject key present in
 *    the cluster, pull in all header-linkless messages with that key and
 *    all existing threads whose subject matches (anchor competition is
 *    decided by root id, so all candidate anchors must be present).
 *
 * Group subjects always come from a member row (or the root row, itself a
 * member when real), so keys computed over steps 1 and 2 already cover
 * every group whose bucket the recompute can influence; no iteration is
 * needed. Threads outside the cluster are untouched, which keeps the write
 * cost at O(cluster) while matching rethreadAll's output exactly.
 */
export function rethreadIncremental(db: Database, messageId: string): RethreadStats {
  const seed = db
    .prepare(`SELECT ${CLUSTER_COLS} FROM messages WHERE message_id = ?`)
    .get(messageId) as ClusterRow | undefined;
  if (!seed) return { clusterSize: 0, rewritten: 0 };

  const cluster = new Map<string, ClusterRow>();
  const mentionedIds = (row: MsgRow): string[] => {
    const ids = refsOf(row);
    if (row.in_reply_to !== null && row.in_reply_to !== row.message_id && row.in_reply_to !== "") {
      ids.push(row.in_reply_to);
    }
    return ids;
  };

  // step 1: closure over header links, through placeholder ids
  const linkStmt = db.prepare(
    `WITH ids(v) AS (SELECT value FROM json_each(?))
     SELECT ${CLUSTER_COLS} FROM messages
     WHERE message_id IN (SELECT v FROM ids)
        OR in_reply_to IN (SELECT v FROM ids)
        OR EXISTS (SELECT 1 FROM json_each(messages.references_json) je
                   WHERE je.value IN (SELECT v FROM ids))`,
  );
  const seen = new Set<string>([seed.message_id]);
  cluster.set(seed.message_id, seed);
  let frontier = [seed.message_id, ...mentionedIds(seed)];
  for (const id of frontier) seen.add(id);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const row of linkStmt.all(JSON.stringify(frontier)) as ClusterRow[]) {
      if (cluster.has(row.message_id)) continue;
      cluster.set(row.message_id, row);
      for (const id of [row.message_id, ...mentionedIds(row)]) {
        if (!seen.has(id)) {
          seen.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }

  const membersStmt = db.prepare(
    `SELECT ${CLUSTER_COLS} FROM messages
     WHERE thread_id IN (SELECT value FROM json_each(?))`,
  );
  const pullThreads = (ids: Set<string>): void => {
    if (ids.size === 0) return;
    for (const row of membersStmt.all(JSON.stringify([...ids].sort())) as ClusterRow[]) {
      cluster.set(row.message_id, row);
    }
  };
  const clusterThreadIds = (): Set<string> => {
    const ids = new Set<string>();
    for (const row of cluster.values()) if (row.thread_id !== null) ids.add(row.thread_id);
    return ids;
  };

  // step 2: pull touched threads in whole
  pullThreads(clusterThreadIds());

  // step 3: subject fallback closure
  const keys = new Set<string>();
  for (const row of cluster.values()) {
    const k = normalizeSubject(row.subject);
    if (k !== "") keys.add(k);
  }
  if (keys.size > 0) {
    const linkless = db
      .prepare(
        `SELECT ${CLUSTER_COLS} FROM messages
         WHERE (in_reply_to IS NULL OR in_reply_to = message_id)
           AND NOT EXISTS (SELECT 1 FROM json_each(messages.references_json) je
                           WHERE je.value <> '' AND je.value <> messages.message_id)`,
      )
      .all() as ClusterRow[];
    for (const row of linkless) {
      if (keys.has(normalizeSubject(row.subject))) cluster.set(row.message_id, row);
    }
    const threads = db.prepare("SELECT thread_id, subject FROM threads").all() as Array<{
      thread_id: string;
      subject: string;
    }>;
    const matched = new Set<string>();
    for (const t of threads) if (keys.has(normalizeSubject(t.subject))) matched.add(t.thread_id);
    pullThreads(matched);
    // completion: any thread partially present must be present in whole
    pullThreads(clusterThreadIds());
  }

  const rows = [...cluster.values()].sort((a, b) => (a.message_id < b.message_id ? -1 : 1));
  const { groups, byId } = computeGroups(rows);
  const oldThreadIds = clusterThreadIds();

  const updateMsg = db.prepare("UPDATE messages SET thread_id = ? WHERE message_id = ?");
  const insertThread = db.prepare(
    "INSERT OR REPLACE INTO threads (thread_id, subject, first_at, last_at) VALUES (?, ?, ?, ?)",
  );
  let rewritten = 0;
  db.transaction(() => {
    db.prepare(
      "DELETE FROM threads WHERE thread_id IN (SELECT value FROM json_each(?))",
    ).run(JSON.stringify([...oldThreadIds].sort()));
    for (const g of groups) {
      const t = threadRowFor(g, byId);
      insertThread.run(t.threadId, t.subject, t.firstAt, t.lastAt);
      for (const m of g.members) {
        updateMsg.run(t.threadId, m);
        if (cluster.get(m)!.thread_id !== t.threadId) rewritten++;
      }
    }
  })();

  return { clusterSize: cluster.size, rewritten };
}
