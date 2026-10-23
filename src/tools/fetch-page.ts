import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { env } from "cloudflare:workers";
import { postingListed } from "../job-boards";
import { callParallel } from "../parallel";

const MAX_PAGE_CHARS = 20_000;
const LIVE_TIMEOUT_MS = 15_000;
const CACHE_TIMEOUT_MS = 25_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CLOSED_NOTICE =
  /no longer (?:available|accepting applications|open|active)|(?:job|position|posting|vacancy|role) (?:is |has been )?(?:closed|expired|filled|removed)|page (?:was )?not found|job not found/i;

type CachedPage = {
  url: string;
  title?: string;
  publish_date?: string | null;
  excerpts?: string[];
  full_content?: string | null;
};

type Status =
  | { kind: "live"; html: string; contentType: string }
  | { kind: "gone"; reason: string }
  | { kind: "unknown"; reason: string };

async function liveStatus(
  url: string,
  abort: AbortSignal | undefined,
): Promise<Status> {
  try {
    return await checkLive(url, withTimeout(abort, LIVE_TIMEOUT_MS));
  } catch (error) {
    if (abort?.aborted) throw error;
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `no answer within ${LIVE_TIMEOUT_MS / 1_000} seconds`
        : String(error);
    return { kind: "unknown", reason: `could not reach the page: ${reason}` };
  }
}

async function checkLive(url: string, signal: AbortSignal): Promise<Status> {
  if ((await postingListed(url, signal)) === false) {
    return { kind: "gone", reason: "not listed on the company's job board" };
  }
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal,
  });
  if (response.status === 404 || response.status === 410) {
    return { kind: "gone", reason: `HTTP ${response.status}` };
  }
  if (!response.ok) {
    return {
      kind: "unknown",
      reason: `HTTP ${response.status}, the site blocks direct reads`,
    };
  }
  const html = await response.text();
  const visibleText = html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  const notice = CLOSED_NOTICE.exec(visibleText)?.[0];
  if (notice) return { kind: "gone", reason: `the page says "${notice}"` };
  if (response.redirected && !sameDocument(url, response.url)) {
    return {
      kind: "unknown",
      reason: `redirects to ${response.url}, often a sign that the posting closed`,
    };
  }
  const contentType = response.headers.get("content-type") ?? "text/html";
  return { kind: "live", html, contentType: contentType.split(";")[0]! };
}

const withTimeout = (abort: AbortSignal | undefined, ms: number) =>
  abort
    ? AbortSignal.any([abort, AbortSignal.timeout(ms)])
    : AbortSignal.timeout(ms);

function sameDocument(requested: string, final: string) {
  const lastSegment = (url: string) =>
    new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  return lastSegment(requested) === lastSegment(final);
}

async function cachedPages(
  urls: string[],
  objective: string,
  conversationId: ConversationId,
  abort: AbortSignal | undefined,
) {
  try {
    const { results = [] } = await callParallel<{ results?: CachedPage[] }>(
      "web_fetch",
      { urls, objective },
      conversationId,
      withTimeout(abort, CACHE_TIMEOUT_MS),
    );
    const byUrl = new Map(results.map((page) => [page.url, page]));
    return urls.map(
      (url, i) =>
        byUrl.get(url) ??
        (results.length === urls.length ? results[i] : undefined),
    );
  } catch (error) {
    if (abort?.aborted) throw error;
    return [];
  }
}

async function toMarkdown(url: string, html: string, contentType: string) {
  try {
    const converted = await env.AI.toMarkdown({
      name: new URL(url).pathname.split("/").pop() || "page.html",
      blob: new Blob([html], { type: contentType }),
    });
    return converted.format === "error" ? undefined : converted.data;
  } catch {
    return undefined;
  }
}

function cachedBody(page: CachedPage | undefined) {
  if (!page) return undefined;
  const body = page.full_content ?? (page.excerpts ?? []).join("\n…\n");
  return [
    page.title?.trim(),
    page.publish_date ? `Published: ${page.publish_date}` : undefined,
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

async function describePage(
  url: string,
  status: Status,
  cached: CachedPage | undefined,
) {
  if (status.kind === "gone") {
    return `${url}\nStatus: gone (${status.reason}). Do not share this link.`;
  }
  if (status.kind === "unknown") {
    const body = cachedBody(cached);
    return [
      url,
      `Status: unknown (${status.reason}). The page could not be confirmed live, so do not share this link as open.`,
      body ? `Cached copy, possibly outdated:\n${body}` : undefined,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, MAX_PAGE_CHARS);
  }
  const body =
    cachedBody(cached) ??
    (await toMarkdown(url, status.html, status.contentType)) ??
    "(no readable text)";
  return `${url}\nStatus: live\n${body}`.slice(0, MAX_PAGE_CHARS);
}

export const fetchPageTool = defineTool({
  name: "fetch_page",
  description:
    "Read web pages, such as a job posting, and check that each one is live now. Returns each page's status (live, gone, or unknown) and the parts that match the objective, such as its posted date and requirements. Search results can point to removed pages, so check every link with this tool before you share it.",
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
    const abort = context.abortSignal;
    const [statuses, cached] = await Promise.all([
      Promise.all(urls.map((url) => liveStatus(url, abort))),
      cachedPages(urls, objective, api.conversationId, abort),
    ]);
    const pages = await Promise.all(
      urls.map((url, i) => describePage(url, statuses[i]!, cached[i])),
    );
    return {
      output: [{ type: "text", text: pages.join("\n\n---\n\n") }],
      isError: statuses.every((status) => status.kind === "unknown"),
    };
  },
});
