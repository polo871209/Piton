import { env } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { defineDocFamily, defineTool } from "@earendil-works/pi-durable";
import {
  BoardNotFound,
  type Opening,
  PROVIDERS,
  type Provider,
} from "../job-boards";
import { formatLocal } from "../time";

const MAX_LISTED = 30;

const BOARD_URLS: [RegExp, Provider][] = [
  [
    /(?:job-)?boards(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/)?([\w-]+)/i,
    "Greenhouse",
  ],
  [/jobs\.(?:eu\.)?lever\.co\/([\w-]+)/i, "Lever"],
  [/jobs\.ashbyhq\.com\/([\w.-]+)/i, "Ashby"],
];

function boardCandidates(board: string): [Provider, string][] {
  for (const [pattern, provider] of BOARD_URLS) {
    const slug = pattern.exec(board)?.[1];
    if (slug) return [[provider, slug]];
  }
  const words = board
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const names = new Set([words.join("-"), words.join("")]);
  return [...names]
    .filter(Boolean)
    .flatMap((name) =>
      (Object.keys(PROVIDERS) as Provider[]).map((p): [Provider, string] => [
        p,
        name,
      ]),
    );
}

async function findBoard(board: string, signal: AbortSignal) {
  for (const [provider, slug] of boardCandidates(board)) {
    try {
      return {
        provider,
        slug,
        openings: await PROVIDERS[provider](slug, signal),
      };
    } catch (error) {
      if (!(error instanceof BoardNotFound)) throw error;
    }
  }
  return undefined;
}

const SeenOpenings = defineDocFamily<
  { ids: string[]; checkedAt: number },
  null
>({
  family: true,
  kind: "piton.seen-openings",
  version: 1,
  scope: "session",
  initial: () => ({ ids: [], checkedAt: 0 }),
  checkpointWhen: () => true,
});

function matches(opening: Opening, filter: string) {
  const haystack = `${opening.title} ${opening.location}`.toLowerCase();
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

const text = (value: string) => [{ type: "text" as const, text: value }];

export const companyJobsTool = defineTool({
  name: "company_jobs",
  description:
    "List the open roles on a company's job board and mark the roles that are new since the last check in this chat. Use it to watch a company for openings. LinkedIn cannot be read, so pass the company's Greenhouse, Lever, or Ashby board instead. If you do not know the board, try the company name, then find its careers page with web_search.",
  parameters: Type.Object({
    board: Type.String({
      minLength: 1,
      description:
        "Board URL, such as https://jobs.ashbyhq.com/gen-digital, or company name, such as Gen Digital.",
    }),
    filter: Type.Optional(
      Type.String({
        description:
          'Words that every listed role must contain in its title or location, such as "engineer kuala lumpur".',
      }),
    ),
  }),
  replay: "safe",
  async execute({ board, filter = "" }, api, context) {
    const earlier = await api.memo<string>("output", context);
    if (earlier !== undefined) return { output: text(earlier) };

    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(context.abortSignal ? [context.abortSignal] : []),
    ]);
    const found = await findBoard(board, signal);
    if (!found) {
      return {
        output: text(
          `No Greenhouse, Lever, or Ashby board found for "${board}". Find the company's careers page with web_search and pass the board URL it links to.`,
        ),
        isError: true,
      };
    }
    const { provider, slug, openings } = found;
    const key = `${api.conversationId}:${provider}:${slug.toLowerCase()}`;
    const seen = await api.snapshot(SeenOpenings, key, context);
    const firstCheck = !seen?.checkedAt;
    const seenIds = new Set(seen?.ids ?? []);
    const isNew = (o: Opening) => !firstCheck && !seenIds.has(o.id);

    const listed = openings
      .filter((o) => matches(o, filter))
      .sort((a, b) => Number(isNew(b)) - Number(isNew(a)));
    const newCount = listed.filter(isNew).length;
    const scope = filter ? ` matching "${filter}"` : "";
    const header = [
      `${provider} board ${slug}: ${listed.length} of ${openings.length} open roles${scope}.`,
      firstCheck
        ? "First check in this chat. Later checks mark new roles."
        : `${newCount} new since ${formatLocal(seen.checkedAt, env.OWNER_TIMEZONE)}.`,
    ].join(" ");
    const lines = listed
      .slice(0, MAX_LISTED)
      .map(
        (o) =>
          `${isNew(o) ? "NEW " : ""}${o.title}${o.location ? ` (${o.location})` : ""} ${o.url}`,
      );
    const more =
      listed.length > MAX_LISTED
        ? [
            `${MAX_LISTED} of ${listed.length} shown. Narrow the filter to see the rest.`,
          ]
        : [];
    const output = await api.memo(
      "output",
      [header, ...lines, ...more].join("\n"),
      context,
    );
    await api.commit(async (tx) => {
      const doc = await tx.doc(SeenOpenings, key, null);
      doc.ids = openings.map((o) => o.id);
      doc.checkedAt = Date.now();
    }, context);
    return { output: text(output) };
  },
});
