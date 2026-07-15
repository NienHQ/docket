import { Buffer } from "node:buffer";

/**
 * A real mbox postmark is "From <envelope-sender> <asctime date>", e.g.
 * "From alice@example.com Mon Jan 22 09:42:00 2024". Requiring the date shape
 * (and a preceding blank line for all but the first) keeps body lines that
 * merely start with "From " out of the split, which would otherwise truncate
 * stored evidence bytes.
 */
const POSTMARK = /^From \S+ \S{3} \S{3} [ \d]\d [\d:]{8} \d{4}/;

/**
 * Split an mbox file on postmark lines and unescape ">From " quoting back to
 * "From " inside bodies (mboxrd: strip exactly one ">"). Uses latin1
 * round-tripping so the returned byte slices are exact.
 */
export function splitMbox(bytes: Uint8Array): Uint8Array[] {
  const text = Buffer.from(bytes).toString("latin1");
  const postmarks: Array<{ start: number; lineEnd: number }> = [];
  for (const m of text.matchAll(/^From .*$/gm)) {
    if (!POSTMARK.test(m[0])) continue;
    if (m.index > 0) {
      const before = text.slice(0, m.index);
      if (!/\r?\n\r?\n$/.test(before)) continue; // not preceded by a blank line
    }
    postmarks.push({ start: m.index, lineEnd: m.index + m[0].length });
  }
  if (postmarks.length === 0) {
    return text.trim() === "" ? [] : [new Uint8Array(Buffer.from(text, "latin1"))];
  }
  const out: Uint8Array[] = [];
  for (let i = 0; i < postmarks.length; i++) {
    const begin = Math.min(postmarks[i]!.lineEnd + 1, text.length);
    const end = i + 1 < postmarks.length ? postmarks[i + 1]!.start : text.length;
    let content = text.slice(begin, end);
    // drop the single blank separator line before the next postmark
    content = content.replace(/\r?\n\r?\n$/, "\n");
    content = content.replace(/^>(>*From )/gm, "$1");
    if (content.trim() === "") continue;
    out.push(new Uint8Array(Buffer.from(content, "latin1")));
  }
  return out;
}
