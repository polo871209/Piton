import type { ConversationId } from "@earendil-works/pi-durable";

export class TransientError extends Error {}

type McpReply = {
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
  error?: { message?: string };
};

function eventStreamData(body: string) {
  return body
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length);
}

// Parallel's free tier rate-limits by session_id, so each conversation gets its own stable id.
async function sessionId(conversationId: ConversationId) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`piton:${conversationId}`),
  );
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Calls a tool on Parallel's free Search MCP and returns its parsed JSON result. */
export async function callParallel<Result>(
  tool: "web_search" | "web_fetch",
  args: Record<string, unknown>,
  conversationId: ConversationId,
  signal: AbortSignal,
): Promise<Result> {
  const response = await fetch("https://search.parallel.ai/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: tool,
        arguments: { ...args, session_id: await sessionId(conversationId) },
      },
    }),
    signal,
  });
  if (response.status === 429 || response.status >= 500) {
    throw new TransientError(`HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  const reply = JSON.parse(eventStreamData(body) ?? body) as McpReply;
  if (reply.error) throw new Error(reply.error.message ?? "unknown error");
  const text = reply.result?.content?.find((c) => c.type === "text")?.text;
  if (!text || reply.result?.isError) throw new Error(text ?? "no content");
  return JSON.parse(text) as Result;
}
