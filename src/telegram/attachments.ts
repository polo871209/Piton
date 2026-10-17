import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import { env } from "cloudflare:workers";
import { type Message, telegram } from "./api";

const MAX_DOWNLOAD_BYTES = 20_000_000;
// Pi stores each transcript entry in one SQLite row, which Durable Objects cap at 2 MB.
const MAX_IMAGE_BYTES = 1_000_000;
const MAX_DOCUMENT_CHARS = 200_000;
const CLAUDE_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

async function download(token: string, fileId: string) {
  const file = await telegram(token).getFile(fileId);
  if (!file.file_path) throw new Error("Telegram gave no file path.");
  const response = await fetch(
    `https://api.telegram.org/file/bot${token}/${file.file_path}`,
  );
  if (!response.ok) {
    throw new Error(`File download failed: ${response.status}.`);
  }
  return response.arrayBuffer();
}

function toBase64(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let start = 0; start < view.length; start += 0x8000) {
    binary += String.fromCharCode(...view.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

async function documentText(
  bytes: ArrayBuffer,
  name: string,
  mimeType: string,
) {
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    return new TextDecoder().decode(bytes);
  }
  const converted = await env.AI.toMarkdown({
    name,
    blob: new Blob([bytes], { type: mimeType }),
  });
  if (converted.format === "error") {
    throw new Error(`Could not read ${name}: ${converted.error}`);
  }
  return converted.data;
}

/** Returns undefined when the message has no text, photo, or file. */
export async function messageInput(
  token: string,
  message: Message,
): Promise<UserInput | undefined> {
  const caption = message.text ?? message.caption ?? "";
  const parts: (TextContent | ImageContent)[] = [];

  const photo = message.photo
    ?.filter((size) => (size.file_size ?? 0) <= MAX_IMAGE_BYTES)
    .at(-1);
  if (message.photo && !photo) {
    throw new Error("The photo is over 1 MB. Send a smaller one.");
  }
  if (photo) {
    const bytes = await download(token, photo.file_id);
    parts.push({
      type: "image",
      mimeType: "image/jpeg",
      data: toBase64(bytes),
    });
  }

  const document = message.document;
  if (document) {
    const name = document.file_name ?? "file";
    const mimeType = document.mime_type ?? "application/octet-stream";
    const size = document.file_size ?? 0;
    if (size > MAX_DOWNLOAD_BYTES) {
      throw new Error(`${name} is over 20 MB, the Telegram bot limit.`);
    }
    const bytes = await download(token, document.file_id);
    if (CLAUDE_IMAGE_TYPES.includes(mimeType)) {
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`${name} is over 1 MB. Send it as a photo.`);
      }
      parts.push({ type: "image", mimeType, data: toBase64(bytes) });
    } else {
      const text = await documentText(bytes, name, mimeType);
      const cut = text.length > MAX_DOCUMENT_CHARS;
      parts.push({
        type: "text",
        text: `File ${name}${cut ? ` (first ${MAX_DOCUMENT_CHARS} characters)` : ""}:\n\n${text.slice(0, MAX_DOCUMENT_CHARS)}`,
      });
    }
  }

  if (parts.length === 0) return caption || undefined;
  if (caption) parts.unshift({ type: "text", text: caption });
  return parts;
}
