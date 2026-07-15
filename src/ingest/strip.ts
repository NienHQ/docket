import type { Fragment, FragmentKind, MessageId } from "../types.js";
import { sha256Hex } from "./eml.js";

const SIG_SEPARATOR = /^-- ?$/;
const ATTRIBUTION = /^On .+ wrote:$/;
const SIGNOFF = /^(Best regards|Regards|Thanks|Kind regards|Best|Cheers),?$/;
const SIGNOFF_TAIL_MAX = 4;
const SHORT_LINE_MAX = 80;

interface Line {
  start: number;
  end: number; // exclusive, excludes the line terminator
  text: string;
}

function splitLines(body: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i === body.length || body[i] === "\n") {
      let end = i;
      if (end > start && body[end - 1] === "\r") end -= 1;
      lines.push({ start, end, text: body.slice(start, end) });
      start = i + 1;
    }
  }
  // a body ending in a newline yields a phantom empty final line
  const last = lines[lines.length - 1];
  if (lines.length > 1 && last && last.start === body.length) lines.pop();
  return lines;
}

function fillBlankKinds(kinds: Array<FragmentKind | null>): FragmentKind[] | null {
  const firstIdx = kinds.findIndex((k) => k !== null);
  if (firstIdx === -1) return null;
  const first = kinds[firstIdx] as FragmentKind;
  const out: FragmentKind[] = new Array(kinds.length);
  let prev: FragmentKind | null = null;
  for (let i = 0; i < kinds.length; i++) {
    const k = kinds[i] ?? null;
    if (k !== null) prev = k;
    out[i] = prev ?? first;
  }
  return out;
}

/**
 * Line-based quote/signature heuristics. Spans index into the exact body
 * string passed in; body.slice(span.start, span.end) === fragment.text.
 */
export function stripFragments(bodyText: string, messageId: MessageId): Fragment[] {
  const lines = splitLines(bodyText);
  if (lines.length === 0) return [];

  let sigStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SIG_SEPARATOR.test(lines[i]!.text)) {
      sigStart = i;
      break;
    }
  }
  const bound = sigStart >= 0 ? sigStart : lines.length;

  // trailing sign-off block: a sign-off line plus up to 4 short lines at the end
  let signoffStart = -1;
  let lastNonBlank = bound - 1;
  while (lastNonBlank >= 0 && lines[lastNonBlank]!.text.trim() === "") lastNonBlank--;
  for (let j = lastNonBlank; j >= 0 && j >= lastNonBlank - SIGNOFF_TAIL_MAX; j--) {
    const t = lines[j]!.text.trim();
    if (SIGNOFF.test(t)) {
      const tail = lines.slice(j + 1, lastNonBlank + 1);
      const tailOk = tail.every(
        (l) => l.text.trim().length <= SHORT_LINE_MAX && !l.text.startsWith(">"),
      );
      if (tailOk) signoffStart = j;
      break;
    }
  }

  const rawKinds: Array<FragmentKind | null> = lines.map((line, i) => {
    if (sigStart >= 0 && i >= sigStart) return "signature";
    if (signoffStart >= 0 && i >= signoffStart && i < bound) return "signature";
    const t = line.text;
    if (t.startsWith(">")) return "quote";
    if (ATTRIBUTION.test(t.trim())) return "quote";
    if (t.trim() === "") return null;
    return "new";
  });

  const kinds = fillBlankKinds(rawKinds);
  if (kinds === null) return [];

  // 16 hex chars (64 bits): fragment_id is a global primary key, and a 32-bit
  // prefix would hit birthday collisions within a large multi-year archive
  const idPrefix = `frg_${sha256Hex(messageId).slice(0, 16)}_`;
  const fragments: Fragment[] = [];
  let n = 0;
  let i = 0;
  while (i < lines.length) {
    const kind = kinds[i]!;
    let j = i;
    while (j + 1 < lines.length && kinds[j + 1] === kind) j++;
    const start = lines[i]!.start;
    const end = lines[j]!.end;
    const text = bodyText.slice(start, end);
    if (text.trim() !== "") {
      fragments.push({
        fragmentId: `${idPrefix}${n}`,
        messageId,
        kind,
        span: { start, end },
        text,
      });
      n++;
    }
    i = j + 1;
  }
  return fragments;
}
