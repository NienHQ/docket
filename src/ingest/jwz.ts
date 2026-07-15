import type { Database } from "better-sqlite3";
import { sha256Hex } from "./eml.js";

interface MsgRow {
  message_id: string;
  subject: string;
  sent_at: string | null;
  in_reply_to: string | null;
  references_json: string;
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

  const refsOf = (row: MsgRow): string[] =>
    (JSON.parse(row.references_json) as string[]).filter(
      (r) => r.length > 0 && r !== row.message_id,
    );

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
  const finalGroups = groups.filter((g) => !consumed.has(g)).concat(mergedGroups);

  const updateMsg = db.prepare("UPDATE messages SET thread_id = ? WHERE message_id = ?");
  const insertThread = db.prepare(
    "INSERT INTO threads (thread_id, subject, first_at, last_at) VALUES (?, ?, ?, ?)",
  );
  db.transaction(() => {
    db.prepare("DELETE FROM threads").run();
    for (const g of finalGroups) {
      const threadId = threadIdForRoot(g.rootId);
      const subjectRow = byId.get(g.rootId) ?? byId.get(earliestMember(g))!;
      const subject = stripSubjectPrefixes(subjectRow.subject);
      const dates = g.members
        .map((m) => byId.get(m)!.sent_at)
        .filter((d): d is string => d !== null)
        .sort();
      insertThread.run(threadId, subject, dates[0] ?? null, dates[dates.length - 1] ?? null);
      for (const m of g.members) updateMsg.run(threadId, m);
    }
  })();
}
