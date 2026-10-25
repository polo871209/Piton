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
  /no longer (?:available|accepting applications|open|active)|(?:job|position|posting|vacancy|role) (?:is |has been )?(?:closed|expired|filled|removed)|page (?:was )?not found|job not found|(?:page|job|posting|position)\b[\w ]{0,30}?(?:doesn['’]t|does not|no longer) exists?/i;
const CURRENCY = String.raw`RM|MYR|S\$|SGD|US\$|USD|\$|€|EUR|£|GBP`;
const AMOUNT = String.raw`(\d[\d,]*(?:\.\d+)?)\s?(k\b)?`;
const SALARY = new RegExp(
  String.raw`(?<![A-Za-z])(${CURRENCY})\s?${AMOUNT}(?:\s?(?:-|–|—|to)\s?(?:${CURRENCY})?\s?${AMOUNT})?`,
  "gi",
);
const CURRENCY_CODES: Record<string, string> = {
  rm: "MYR",
  s$: "SGD",
  us$: "USD",
  $: "USD",
  "€": "EUR",
  "£": "GBP",
};

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

function pageStatus(live: Status, cached: CachedPage | undefined): Status {
  if (live.kind === "gone") return live;
  const notice = CLOSED_NOTICE.exec(cachedBody(cached) ?? "")?.[0];
  return notice ? { kind: "gone", reason: `the page says "${notice}"` } : live;
}

function salaryValues(text: string) {
  const values = new Set<string>();
  for (const [, currency, low, lowK, high, highK] of text.matchAll(SALARY)) {
    const from = amount(low!, lowK ?? highK);
    const to = high ? amount(high, highK) : undefined;
    if (from < 1_000) continue;
    const code =
      CURRENCY_CODES[currency!.toLowerCase()] ?? currency!.toUpperCase();
    const range =
      to && to !== from ? `${format(from)}-${format(to)}` : format(from);
    values.add(`${code} ${range}`);
  }
  return [...values];
}

const amount = (digits: string, thousands: string | undefined) =>
  Number(digits.replaceAll(",", "")) * (thousands ? 1_000 : 1);

const format = (value: number) => value.toLocaleString("en-US");

function salaryWarning(body: string) {
  const values = salaryValues(body);
  if (values.length < 2) return undefined;
  return `Salary: the page states ${values.length} different salary values (${values.join("; ")}). They can belong to other listings on the page or be estimates, so do not give one as this role's salary unless the posting text ties it to this role.`;
}

async function describePage(
  url: string,
  status: Status,
  cached: CachedPage | undefined,
) {
  if (status.kind === "gone") {
    return `${url}\nStatus: gone (${status.reason}). Do not share this link.`;
  }
  const body =
    status.kind === "live"
      ? (cachedBody(cached) ??
        (await toMarkdown(url, status.html, status.contentType)) ??
        "(no readable text)")
      : cachedBody(cached);
  const statusLine =
    status.kind === "live"
      ? "Status: live"
      : `Status: unknown (${status.reason}). The page could not be confirmed live, so do not share this link as open.`;
  return [
    url,
    statusLine,
    body && salaryWarning(body),
    body && status.kind === "unknown"
      ? `Cached copy, possibly outdated:\n${body}`
      : body,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_PAGE_CHARS);
}

export const fetchPageTool = defineTool({
  name: "fetch_page",
  description:
    "Read web pages, such as a job posting, and check that each one is live now. Returns each page's status (live, gone, or unknown) and the parts that match the objective, such as its posted date and requirements, and flags a page that states conflicting salary values. Search results can point to removed pages, so check every link with this tool before you share it.",
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
    const pages = urls.map((url, i) => ({
      url,
      status: pageStatus(statuses[i]!, cached[i]),
      cached: cached[i],
    }));
    const described = await Promise.all(
      pages.map((page) => describePage(page.url, page.status, page.cached)),
    );
    return {
      output: [{ type: "text", text: described.join("\n\n---\n\n") }],
      isError: pages.every((page) => page.status.kind === "unknown"),
    };
  },
});
