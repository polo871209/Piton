// Closure and anti-bot patterns adapted from career-ops: https://github.com/career-ops-hq/career-ops/blob/main/liveness-core.mjs

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)";

const CLOSURE_PATTERNS = [
  /\bno longer (?:available|accepting applications|open|active)\b/i,
  /\b(?:job|position|posting|vacancy|role|opening|requisition|listing)\b[\s\S]{0,60}?(?<!\b(?:application|form) )has been filled\b(?! out)/i,
  /\b(?:job|posting|position|vacancy|role)(?: posting)? (?:is |has )?expired\b/i,
  /\b(?:job|role|position|posting|vacancy)(?: listing)? (?:is |has been )?(?:closed|removed)\b(?!-)/i,
  /\bapplications? (?:(?:have|are|is) )?closed\b(?!-)/i,
  new RegExp(
    String.raw`(?<!\bbe )\bclosed on (?:\d{1,2} ${MONTH}|${MONTH}\w* \d{1,2})`,
    "i",
  ),
  /\b(?:job|page) (?:was )?not found\b/i,
  /\b(?:page|job|posting|position)\b[\w ]{0,30}?(?:doesn't|does not|no longer) exists?\b/i,
  /\bcan't view this job because it's not available\b/i,
];

const BOT_CHALLENGES = [
  /\bjust a moment\b/i,
  /\bperforming security verification\b/i,
  /\bchecking your browser before\b/i,
  /\bverify you are (?:a |not a )?human\b/i,
  /\benable javascript and cookies to continue\b/i,
  /\bplease complete the security check\b/i,
];

// A live posting often says how it will close, such as "open until the position has been filled", so a match that a time or condition word opens is not a closure.
const TIME_OR_CONDITION_CLAUSE =
  /\b(?:until|till|once|when|whenever|after|before|unless|if|whether|as soon as) (?:[^\s.,;:!?|•·]+ ){0,9}[^\s.,;:!?|•·]+$/i;

const JOB_ID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,}/gi;

const ENTITIES: Record<string, string> = {
  amp: "&",
  nbsp: " ",
  quot: '"',
  apos: "'",
  rsquo: "'",
  lsquo: "'",
  "#39": "'",
  "#x27": "'",
};

/** Visible page text, one line per block element. */
export function visibleText(html: string) {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(
      /<\/?(?:p|div|li|ul|ol|h[1-6]|br|tr|section|article|header|footer|main|nav|button|a)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#?\w+);/g, (entity, name: string) => ENTITIES[name] ?? entity);
}

function normalize(text: string) {
  return text
    .replace(/[‘’ʼ′´`]/g, "'")
    .replace(/[“”″]/g, '"')
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, (run) => (run.includes("\n") ? "\n" : " "));
}

/** The first sentence on the page that says the posting is closed. */
export function closureNotice(text: string) {
  const lines = normalize(text);
  const flat = lines.replace(/\n/g, " ");
  for (const pattern of CLOSURE_PATTERNS) {
    for (const match of flat.matchAll(new RegExp(pattern, "gi"))) {
      const before = lines.slice(0, match.index + match[0].length);
      if (!TIME_OR_CONDITION_CLAUSE.test(before)) return match[0];
    }
  }
  return undefined;
}

export function isBotChallenge(text: string) {
  const flat = normalize(text);
  return BOT_CHALLENGES.some((pattern) => pattern.test(flat));
}

/** Whether a redirect left the posting, judged by the job ID in the requested URL, else by its last path segment. */
export function leftPosting(requested: string, final: string) {
  const id = requested.match(JOB_ID)?.at(-1)?.toLowerCase();
  if (id) return !final.toLowerCase().includes(id);
  const lastSegment = (url: string) =>
    new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  return lastSegment(requested) !== lastSegment(final);
}

export type PostingFacts = {
  postedOn?: string;
  closesOn?: string;
  employer?: string;
};

/** Dates and employer from the page's schema.org JobPosting data. */
export function jobPostingFacts(html: string): PostingFacts {
  for (const [, json] of html.matchAll(
    /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let data: unknown;
    try {
      data = JSON.parse(json!);
    } catch {
      continue;
    }
    const posting = findJobPosting(data);
    if (posting) {
      return {
        postedOn: isoDay(posting.datePosted),
        closesOn: isoDay(posting.validThrough),
        employer: employerName(posting.hiringOrganization),
      };
    }
  }
  return {};
}

type JsonLdNode = Record<string, unknown>;

function employerName(organization: unknown): string | undefined {
  const first = [organization].flat()[0];
  const name =
    typeof first === "object" && first !== null
      ? (first as JsonLdNode).name
      : first;
  return typeof name === "string" ? name.trim() || undefined : undefined;
}

function findJobPosting(data: unknown): JsonLdNode | undefined {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const node = data as JsonLdNode;
  const types = [node["@type"]].flat();
  if (types.includes("JobPosting")) return node;
  return findJobPosting(node["@graph"]);
}

function isoDay(value: unknown) {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toISOString().slice(0, 10);
}
