import { createHash } from "node:crypto";
import PostalMime from "postal-mime";
import type { Address } from "postal-mime";
import type { MessageId } from "../types.js";

export interface ParsedRecipient {
  name: string;
  address: string;
  kind: "to" | "cc" | "bcc";
}

export interface ParsedAttachment {
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ParsedEmail {
  messageId: MessageId;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  fromName: string;
  fromAddress: string;
  recipients: ParsedRecipient[];
  sentAt: string | null;
  bodyText: string;
  attachments: ParsedAttachment[];
}

export function sha256Hex(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stripBrackets(id: string): string {
  return id.trim().replace(/^</, "").replace(/>$/, "");
}

function parseIdList(raw: string | undefined): string[] {
  if (!raw) return [];
  const angled = raw.match(/<[^<>\s]+>/g);
  if (angled) return angled.map(stripBrackets);
  return raw
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(stripBrackets);
}

function flattenAddresses(list: Address[] | undefined): Array<{ name: string; address: string }> {
  const out: Array<{ name: string; address: string }> = [];
  for (const a of list ?? []) {
    if (a.group) {
      for (const m of a.group) {
        if (m.address) out.push({ name: m.name ?? "", address: m.address });
      }
    } else if (a.address) {
      out.push({ name: a.name ?? "", address: a.address });
    }
  }
  return out;
}

function contentToBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
}

export async function parseEml(bytes: Uint8Array): Promise<ParsedEmail> {
  const email = await PostalMime.parse(bytes, { attachmentEncoding: "arraybuffer" });

  const messageId: MessageId = email.messageId
    ? stripBrackets(email.messageId)
    : `synth-${sha256Hex(bytes)}`;

  const references = parseIdList(email.references).filter((r) => r.length > 0);
  const inReplyTo = parseIdList(email.inReplyTo)[0] ?? null;

  let sentAt: string | null = null;
  if (email.date) {
    const d = new Date(email.date);
    if (!Number.isNaN(d.getTime())) sentAt = d.toISOString();
  }

  const from = flattenAddresses(email.from ? [email.from] : [])[0];

  const recipients: ParsedRecipient[] = [];
  for (const r of flattenAddresses(email.to)) recipients.push({ ...r, kind: "to" });
  for (const r of flattenAddresses(email.cc)) recipients.push({ ...r, kind: "cc" });
  for (const r of flattenAddresses(email.bcc)) recipients.push({ ...r, kind: "bcc" });

  const attachments: ParsedAttachment[] = email.attachments.map((a) => ({
    filename: a.filename ?? "",
    mime: a.mimeType || "application/octet-stream",
    bytes: contentToBytes(a.content),
  }));

  return {
    messageId,
    inReplyTo,
    references,
    subject: email.subject ?? "",
    fromName: from?.name ?? "",
    fromAddress: from?.address ?? "",
    recipients,
    sentAt,
    bodyText: email.text ?? (email.html ? htmlToText(email.html) : ""),
    attachments,
  };
}

/**
 * Deterministic fallback for HTML-only mail so it stays retrievable. This is
 * not a faithful renderer: block-ish tags become newlines, the rest is
 * stripped, common entities decoded, whitespace collapsed.
 */
export function htmlToText(html: string): string {
  const ENTITIES: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table|\/blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
