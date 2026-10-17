import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

const RESULT_LIMIT = 5;
const SNIPPET_CHARS = 1_000;
const PROVIDER_TIMEOUT_MS = 20_000;

type SearchResult = { title: string; url: string; content: string };

class TransientSearchError extends Error {}

function assertOk(response: Response) {
  if (response.status === 429 || response.status >= 500) {
    throw new TransientSearchError(`HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

function isTransient(error: unknown) {
  return (
    error instanceof TransientSearchError ||
    (error instanceof TypeError && /fetch|network|socket/i.test(error.message))
  );
}

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

async function parallelSearch(query: string, signal: AbortSignal) {
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
        name: "web_search",
        arguments: { objective: query, search_queries: [query] },
      },
    }),
    signal,
  });
  assertOk(response);
  const body = await response.text();
  const reply = JSON.parse(eventStreamData(body) ?? body) as McpReply;
  if (reply.error) throw new Error(reply.error.message ?? "unknown error");
  const text = reply.result?.content?.find((c) => c.type === "text")?.text;
  if (!text || reply.result?.isError) throw new Error(text ?? "no content");
  const { results = [] } = JSON.parse(text) as {
    results?: { url?: string; title?: string; excerpts?: string[] }[];
  };
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

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&");
}

const cleanText = (text: string) =>
  decodeEntities(text).replace(/\s+/g, " ").trim();

async function duckDuckGoSearch(query: string, signal: AbortSignal) {
  const response = await fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    body: new URLSearchParams({ q: query }),
    signal,
  });
  assertOk(response);
  // DuckDuckGo answers a blocked request with 202 and a challenge page.
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const results: SearchResult[] = [];
  await new HTMLRewriter()
    .on("a.result-link", {
      element(link) {
        const url = decodeEntities(link.getAttribute("href") ?? "");
        results.push({ title: "", url, content: "" });
      },
      text(chunk) {
        const last = results.at(-1);
        if (last) last.title += chunk.text;
      },
    })
    .on("td.result-snippet", {
      text(chunk) {
        const last = results.at(-1);
        if (last) last.content += chunk.text;
      },
    })
    .transform(response)
    .arrayBuffer();
  return results
    .filter((r) => /^https?:\/\//.test(r.url))
    .map((r) => ({
      title: cleanText(r.title),
      url: r.url,
      content: cleanText(r.content),
    }));
}

const PROVIDERS = [
  { name: "Parallel", search: parallelSearch, attempts: 2 },
  { name: "DuckDuckGo", search: duckDuckGoSearch, attempts: 1 },
];

const TRACKING_PARAMETER = /^(utm_|gclid$|fbclid$|mc_|ref$|source$)/i;

function pageKey(raw: string) {
  const url = new URL(raw);
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETER.test(name)) url.searchParams.delete(name);
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return `${host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
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
  provider: (typeof PROVIDERS)[number],
  query: string,
  callerSignal: AbortSignal | undefined,
) {
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout;
    try {
      return uniqueResults(await provider.search(query, signal));
    } catch (error) {
      if (attempt >= provider.attempts || !isTransient(error)) throw error;
      await scheduler.wait(500 + Math.random() * 250);
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
  async execute({ query }, _api, context) {
    const failures: string[] = [];
    for (const provider of PROVIDERS) {
      try {
        const results = await searchWithRetry(
          provider,
          query,
          context.abortSignal,
        );
        if (results.length > 0) {
          return { output: [{ type: "text", text: formatResults(results) }] };
        }
        failures.push(`${provider.name}: no results`);
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${provider.name}: ${message}`);
      }
    }
    return {
      output: [
        { type: "text", text: `Web search failed. ${failures.join("; ")}` },
      ],
      isError: true,
    };
  },
});
