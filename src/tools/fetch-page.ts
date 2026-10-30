import { env } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { errorText } from "../errors";
import { listedOpening } from "../job-boards";
import {
  closureNotice,
  isBotChallenge,
  jobPostingFacts,
  leftPosting,
  type PostingFacts,
  visibleText,
} from "../liveness";
import { callParallel } from "../parallel";
import { BROWSER_USER_AGENT, pageKey, withTimeout } from "../web";

const MAX_PAGE_CHARS = 20_000;
const LIVE_TIMEOUT_MS = 15_000;
const CACHE_TIMEOUT_MS = 25_000;
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
  | {
      kind: "live";
      onBoard: boolean;
      page?: { html: string; contentType: string };
    }
  | { kind: "gone"; reason: string }
  | { kind: "unknown"; reason: string };

type Checked = { status: Status; facts: PostingFacts };

async function checkPage(
  url: string,
  abort: AbortSignal | undefined,
): Promise<Checked> {
  try {
    return await checkLive(url, withTimeout(abort, LIVE_TIMEOUT_MS));
  } catch (error) {
    if (abort?.aborted) throw error;
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `no answer within ${LIVE_TIMEOUT_MS / 1_000} seconds`
        : String(error);
    return {
      status: {
        kind: "unknown",
        reason: `could not reach the page: ${reason}`,
      },
      facts: {},
    };
  }
}

async function checkLive(url: string, signal: AbortSignal): Promise<Checked> {
  const opening = await listedOpening(url, signal);
  if (opening === null) {
    return {
      status: { kind: "gone", reason: "not listed on the company's job board" },
      facts: {},
    };
  }
  const response = await fetch(url, {
    headers: { "user-agent": BROWSER_USER_AGENT },
    signal,
  });
  const html = response.ok ? await response.text() : "";
  const facts = jobPostingFacts(html);
  if (opening?.postedOn) facts.postedOn = opening.postedOn;
  const page = response.ok
    ? {
        html,
        contentType: (response.headers.get("content-type") ?? "text/html")
          .split(";")[0]!
          .trim(),
      }
    : undefined;
  if (opening) return { status: { kind: "live", onBoard: true, page }, facts };
  return { status: pageStatus(url, response, page, facts), facts };
}

function pageStatus(
  requested: string,
  response: Response,
  page: { html: string; contentType: string } | undefined,
  facts: PostingFacts,
): Status {
  if (response.status === 404 || response.status === 410) {
    return { kind: "gone", reason: `HTTP ${response.status}` };
  }
  if (!page) {
    const blocked = [401, 403, 429].includes(response.status);
    return {
      kind: "unknown",
      reason: `HTTP ${response.status}${blocked ? ", the site blocks direct reads" : ""}`,
    };
  }
  const text = visibleText(page.html);
  if (isBotChallenge(text)) {
    return {
      kind: "unknown",
      reason: "the site answered with an anti-bot check instead of the page",
    };
  }
  const notice = closureNotice(text);
  if (notice) return { kind: "gone", reason: `the page says "${notice}"` };
  if (response.redirected && leftPosting(requested, response.url)) {
    return {
      kind: "unknown",
      reason: `redirects to ${response.url}, often a sign that the posting closed`,
    };
  }
  if (
    facts.closesOn &&
    facts.closesOn < new Date().toISOString().slice(0, 10)
  ) {
    return {
      kind: "unknown",
      reason: `its closing date, ${facts.closesOn}, has passed`,
    };
  }
  return { kind: "live", onBoard: false, page };
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
    const byPage = new Map(results.map((page) => [pageKey(page.url), page]));
    return urls.map((url) => byPage.get(pageKey(url)));
  } catch (error) {
    if (abort?.aborted) throw error;
    console.error("Parallel web_fetch failed", errorText(error));
    return [];
  }
}

async function toMarkdown(url: string, html: string, contentType: string) {
  try {
    const converted = await env.AI.toMarkdown({
      name: new URL(url).pathname.split("/").pop() || "page.html",
      blob: new Blob([html], { type: contentType }),
    });
    if (converted.format !== "error") return converted.data;
    console.error("toMarkdown failed", url, converted.error);
  } catch (error) {
    console.error("toMarkdown failed", url, errorText(error));
  }
  return undefined;
}

async function pageText(
  url: string,
  page: { html: string; contentType: string },
) {
  const markdown = await toMarkdown(url, page.html, page.contentType);
  if (markdown?.trim()) return markdown;
  const text = visibleText(page.html)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text || undefined;
}

function cachedBody(page: CachedPage | undefined, facts: PostingFacts) {
  if (!page) return undefined;
  const body = page.full_content ?? (page.excerpts ?? []).join("\n…\n");
  const published =
    page.publish_date && !facts.postedOn
      ? `Published: ${page.publish_date}`
      : undefined;
  return [page.title?.trim(), published, body].filter(Boolean).join("\n");
}

function withCachedNotice(status: Status, cached: CachedPage | undefined) {
  if (status.kind === "gone" || (status.kind === "live" && status.onBoard)) {
    return status;
  }
  const notice = closureNotice(cachedBody(cached, {}) ?? "");
  return notice
    ? { kind: "gone" as const, reason: `the page says "${notice}"` }
    : status;
}

function factLines({ postedOn, closesOn, employer }: PostingFacts) {
  return [
    postedOn && `Posted: ${postedOn}`,
    closesOn && `Closes: ${closesOn}`,
    employer && `Employer: ${employer}`,
  ];
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
  { status, facts }: Checked,
  cached: CachedPage | undefined,
) {
  if (status.kind === "gone") {
    return `${url}\nStatus: gone (${status.reason}). Do not share this link.`;
  }
  const body =
    status.kind === "live"
      ? (cachedBody(cached, facts) ??
        (status.page && (await pageText(url, status.page))) ??
        "(no readable text)")
      : cachedBody(cached, facts);
  const statusLine =
    status.kind === "live"
      ? `Status: live${status.onBoard ? " (listed on the company's job board)" : ""}`
      : `Status: unknown (${status.reason}). The page could not be confirmed live, so do not share this link as open.`;
  return [
    url,
    statusLine,
    ...factLines(facts),
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
    "Read web pages, such as a job posting, and check that each one is live now. Returns each page's status (live, gone, or unknown), the posting's posted date, closing date, and employer when the page states them, and the parts that match the objective, such as its requirements, and flags a page that states conflicting salary values. Search results can point to removed pages, so check every link with this tool before you share it.",
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
    const [checked, cached] = await Promise.all([
      Promise.all(urls.map((url) => checkPage(url, abort))),
      cachedPages(urls, objective, api.conversationId, abort),
    ]);
    const pages = urls.map((url, i) => ({
      url,
      checked: {
        ...checked[i]!,
        status: withCachedNotice(checked[i]!.status, cached[i]),
      },
      cached: cached[i],
    }));
    const described = await Promise.all(
      pages.map((page) => describePage(page.url, page.checked, page.cached)),
    );
    return {
      output: [{ type: "text", text: described.join("\n\n---\n\n") }],
      isError: pages.every((page) => page.checked.status.kind === "unknown"),
    };
  },
});
