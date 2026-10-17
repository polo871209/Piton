import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { env } from "cloudflare:workers";
import { callParallel } from "../parallel";

const MAX_PAGE_CHARS = 20_000;
const TIMEOUT_MS = 45_000;

type Page = {
  url: string;
  title?: string;
  publish_date?: string | null;
  excerpts?: string[];
  full_content?: string | null;
};

async function parallelFetch(
  urls: string[],
  objective: string,
  conversationId: ConversationId,
  signal: AbortSignal,
) {
  const { results = [], errors = [] } = await callParallel<{
    results?: Page[];
    errors?: { url?: string; error_type?: string; content?: string }[];
  }>("web_fetch", { urls, objective }, conversationId, signal);
  const failed = errors.map(
    (e) => `${e.url ?? "?"}: ${e.content ?? e.error_type ?? "failed"}`,
  );
  return { pages: results, failed };
}

async function directFetch(url: string, signal: AbortSignal): Promise<Page> {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = (response.headers.get("content-type") ?? "text/html").split(
    ";",
  )[0]!;
  const converted = await env.AI.toMarkdown({
    name: new URL(url).pathname.split("/").pop() || "page.html",
    blob: new Blob([await response.arrayBuffer()], { type }),
  });
  if (converted.format === "error") throw new Error(converted.error);
  return { url, full_content: converted.data };
}

function formatPage(page: Page) {
  const body = page.full_content ?? (page.excerpts ?? []).join("\n…\n");
  const lines = [
    page.title?.trim(),
    page.url,
    page.publish_date ? `Published: ${page.publish_date}` : undefined,
    body.slice(0, MAX_PAGE_CHARS),
  ];
  return lines.filter(Boolean).join("\n");
}

export const fetchPageTool = defineTool({
  name: "fetch_page",
  description:
    "Read web pages, such as a job posting, to check facts that search snippets do not show: whether it is still open, its posted date, and its requirements. Returns the parts of each page that match the objective.",
  parameters: Type.Object({
    urls: Type.Array(Type.String({ format: "uri" }), {
      minItems: 1,
      maxItems: 10,
    }),
    objective: Type.String({
      minLength: 1,
      maxLength: 200,
      description: "What to find on the pages, in one sentence.",
    }),
  }),
  replay: "safe",
  async execute({ urls, objective }, api, context) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = context.abortSignal
      ? AbortSignal.any([context.abortSignal, timeout])
      : timeout;
    let pages: Page[] = [];
    let failed: string[] = [];
    try {
      ({ pages, failed } = await parallelFetch(
        urls,
        objective,
        api.conversationId,
        signal,
      ));
    } catch (error) {
      if (context.abortSignal?.aborted) throw error;
      const read = await Promise.allSettled(
        urls.map((url) => directFetch(url, signal)),
      );
      pages = read.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      failed = read.flatMap((r, i) =>
        r.status === "rejected"
          ? [
              `${urls[i]}: ${r.reason instanceof Error ? r.reason.message : r.reason}`,
            ]
          : [],
      );
    }
    const text = [
      ...pages.map(formatPage),
      ...(failed.length > 0 ? [`Could not read:\n${failed.join("\n")}`] : []),
    ].join("\n\n---\n\n");
    return {
      output: [{ type: "text", text }],
      isError: pages.length === 0,
    };
  },
});
