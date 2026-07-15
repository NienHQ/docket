import type { Span } from "../types.js";

export const MAX_CHUNK_CHARS = 1200;

function isWs(text: string, i: number): boolean {
  const c = text[i];
  return c !== undefined && /\s/.test(c);
}

function trimSpan(text: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && isWs(text, start)) start++;
  while (end > start && isWs(text, end - 1)) end--;
  return { start, end };
}

/** Paragraphs are runs of non-blank lines; blank (or whitespace-only) lines separate them. */
function paragraphSpans(text: string): Span[] {
  const out: Span[] = [];
  const sep = /\n[ \t]*\n+/g;
  let start = 0;
  for (;;) {
    const m = sep.exec(text);
    const end = m ? m.index : text.length;
    const p = trimSpan(text, { start, end });
    if (p.end > p.start) out.push(p);
    if (!m) break;
    start = m.index + m[0].length;
  }
  return out;
}

/** Oversized paragraph: cut at the last whitespace before the cap, hard cut when none. */
function splitLong(text: string, span: Span, maxLen: number): Span[] {
  const out: Span[] = [];
  let start = span.start;
  while (start < span.end) {
    let end = Math.min(start + maxLen, span.end);
    if (end < span.end) {
      const slice = text.slice(start, end);
      const ws = Math.max(
        slice.lastIndexOf(" "),
        slice.lastIndexOf("\n"),
        slice.lastIndexOf("\t"),
      );
      if (ws > 0) end = start + ws;
    }
    const piece = trimSpan(text, { start, end });
    if (piece.end > piece.start) out.push(piece);
    start = end;
    while (start < span.end && isWs(text, start)) start++;
  }
  return out;
}

/**
 * Paragraph-aligned chunk spans over `text`, each at most maxLen chars.
 * Deterministic: the same text always yields the same spans (spec invariant 3).
 * Offsets are into `text`; callers add their own base offset.
 */
export function chunkSpans(text: string, maxLen: number = MAX_CHUNK_CHARS): Span[] {
  const out: Span[] = [];
  let cur: Span | null = null;
  const flush = (): void => {
    if (cur) {
      out.push(cur);
      cur = null;
    }
  };
  for (const p of paragraphSpans(text)) {
    if (p.end - p.start > maxLen) {
      flush();
      out.push(...splitLong(text, p, maxLen));
      continue;
    }
    if (cur === null) {
      cur = { start: p.start, end: p.end };
    } else if (p.end - cur.start <= maxLen) {
      cur.end = p.end;
    } else {
      flush();
      cur = { start: p.start, end: p.end };
    }
  }
  flush();
  return out;
}
