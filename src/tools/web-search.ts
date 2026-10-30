import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { errorText } from "../errors";
import { callParallel } from "../parallel";
import { pageKey, TransientError, withTimeout } from "../web";

const RESULT_LIMIT = 5;
const SNIPPET_CHARS = 1_000;
const PROVIDER_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

type SearchResult = { title: string; url: string; content: string };

function isTransient(error: unknown) {
  return (
    error instanceof TransientError ||
    (error instanceof TypeError && /fetch|network|socket/i.test(error.message))
  );
}

async function parallelSearch(
  query: string,
  signal: AbortSignal,
  conversationId: ConversationId,
) {
  const { results = [] } = await callParallel<{
    results?: { url?: string; title?: string; excerpts?: string[] }[];
  }>(
    "web_search",
    { objective: query, search_queries: [query] },
    conversationId,
    signal,
  );
  return results.flatMap((r): SearchResult[] =>
    r.url
      ? [
          {
            title: r.title?.trim() ?? "",
            url: r.url,
            content: (r.excerpts ?? []).join(" … ").trim(),
          },
        ]
      : [],
  );
}

function uniqueResults(results: SearchResult[]) {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = pageKey(result.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function searchWithRetry(
  query: string,
  conversationId: ConversationId,
  callerSignal: AbortSignal | undefined,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return uniqueResults(
        await parallelSearch(
          query,
          withTimeout(callerSignal, PROVIDER_TIMEOUT_MS),
          conversationId,
        ),
      );
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isTransient(error)) throw error;
      await scheduler.wait(RETRY_DELAY_MS * attempt);
    }
  }
}

function formatResults(results: SearchResult[]) {
  return results
    .slice(0, RESULT_LIMIT)
    .map(
      (r, i) =>
        `${i + 1}. ${r.title}\n${r.url}\n${r.content.slice(0, SNIPPET_CHARS)}`,
    )
    .join("\n\n");
}

export const webSearchTool = defineTool({
  name: "web_search",
  description:
    "Search the web. Each result has a title, a URL, and a snippet. Use it for news, prices, schedules, and any fact that can change after your training. Put the year in the query when recency matters.",
  parameters: Type.Object({
    query: Type.String({ minLength: 1, maxLength: 400 }),
  }),
  replay: "safe",
  async execute({ query }, api, context) {
    try {
      const results = await searchWithRetry(
        query,
        api.conversationId,
        context.abortSignal,
      );
      return {
        output: [
          {
            type: "text",
            text: results.length > 0 ? formatResults(results) : "No results.",
          },
        ],
      };
    } catch (error) {
      if (context.abortSignal?.aborted) throw error;
      return {
        output: [
          { type: "text", text: `Web search failed: ${errorText(error)}` },
        ],
        isError: true,
      };
    }
  },
});
