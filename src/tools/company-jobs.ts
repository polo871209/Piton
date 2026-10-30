import { env } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineDocFamily,
  defineTool,
} from "@earendil-works/pi-durable";
import {
  BoardNotFound,
  type Opening,
  PROVIDERS,
  type Provider,
} from "../job-boards";
import { formatLocal } from "../time";
import { withTimeout } from "../web";

const MAX_LISTED = 30;

const BOARD_URLS: [RegExp, Provider][] = [
  [
    /(?:job-)?boards(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/)?([\w-]+)/i,
    "Greenhouse",
  ],
  [/jobs\.(?:eu\.)?lever\.co\/([\w-]+)/i, "Lever"],
  [/jobs\.ashbyhq\.com\/([\w.-]+)/i, "Ashby"],
  [/(?:careers|jobs)\.smartrecruiters\.com\/([\w-]+)/i, "SmartRecruiters"],
  [/apply\.workable\.com\/(?!j\/|api\/)([\w-]+)/i, "Workable"],
  [/\/\/([\w-]+)\.recruitee\.com/i, "Recruitee"],
  [/\/\/([\w-]+)\.breezy\.hr/i, "Breezy"],
];

type Board = { provider: Provider; slug: string };

function boardFromUrl(board: string): Board | undefined {
  for (const [pattern, provider] of BOARD_URLS) {
    const slug = pattern.exec(board)?.[1];
    if (slug) return { provider, slug };
  }
  if (URL.canParse(board)) {
    return { provider: "Teamtailor", slug: new URL(board).host };
  }
  return undefined;
}

function guessedBoards(name: string): Board[] {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const slugs = [...new Set([words.join("-"), words.join("")])].filter(Boolean);
  return slugs.flatMap((slug) =>
    (Object.keys(PROVIDERS) as Provider[]).map((provider) => ({
      provider,
      slug,
    })),
  );
}

async function readBoard(board: Board, signal: AbortSignal) {
  return {
    ...board,
    openings: await PROVIDERS[board.provider](board.slug, signal),
  };
}

async function firstBoardFound(boards: Board[], signal: AbortSignal) {
  const results = await Promise.allSettled(
    boards.map((board) => readBoard(board, signal)),
  );
  const found = results.flatMap((r) =>
    r.status === "fulfilled" ? [r.value] : [],
  );
  const failure = results.find(
    (r): r is PromiseRejectedResult =>
      r.status === "rejected" && !(r.reason instanceof BoardNotFound),
  );
  const best = found.find((b) => b.openings.length > 0) ?? found[0];
  if (!best && failure) throw failure.reason;
  return best;
}

async function findBoard(
  board: string,
  direct: Board | undefined,
  known: Board | undefined,
  signal: AbortSignal,
) {
  if (direct) return firstBoardFound([direct], signal);
  if (known) {
    const found = await firstBoardFound([known], signal);
    if (found) return found;
  }
  return firstBoardFound(guessedBoards(board), signal);
}

const KnownBoards = defineDoc<{ boards: Record<string, Board> }>({
  kind: "piton.known-boards",
  version: 1,
  scope: "session",
  initial: () => ({ boards: {} }),
  checkpointWhen: () => true,
});

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

function matches(opening: Opening, filter: string, exclude: string) {
  const haystack = `${opening.title} ${opening.location}`.toLowerCase();
  const titleWords = words(opening.title.replace(/[^\p{L}\p{N}]+/gu, " "));
  return (
    words(filter).every((word) => haystack.includes(word)) &&
    !words(exclude).some((word) => titleWords.some((t) => t.startsWith(word)))
  );
}

const words = (phrase: string) =>
  phrase.toLowerCase().split(/\s+/).filter(Boolean);

const describeOpening = (o: Opening, isNew: boolean) =>
  `${isNew ? "NEW " : ""}${o.title}${o.location ? ` (${o.location})` : ""}${o.postedOn ? `, posted ${o.postedOn}` : ""} ${o.url}`;

const newestFirst = (a: Opening, b: Opening) =>
  (b.postedOn ?? "").localeCompare(a.postedOn ?? "");

const text = (value: string) => [{ type: "text" as const, text: value }];

type Check = {
  output: string;
  seenKey: string;
  seenIds: string[];
  checkedAt: number;
  knownBoard?: { name: string; board: Board };
};

export const companyJobsTool = defineTool({
  name: "company_jobs",
  deferred: true,
  description:
    "List the open roles on a company's job board, with posted dates, and mark the roles that are new since the last check in this chat. After the first check in a chat, it lists only new roles in full. Use it to watch a company for openings. LinkedIn cannot be read, so pass the company's Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Breezy, or Teamtailor board instead. If you do not know the board, try the company name, then find its careers page with web_search.",
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
    exclude: Type.Optional(
      Type.String({
        description:
          'Words that drop a role if its title contains any of them, such as "lead manager principal".',
      }),
    ),
    all: Type.Optional(
      Type.Boolean({
        description:
          "List every matching role with its link, also roles seen in earlier checks.",
      }),
    ),
  }),
  replay: "safe",
  async execute(
    { board, filter = "", exclude = "", all = false },
    api,
    context,
  ) {
    const commitCheck = async (saved: Check) => {
      await api.commit(async (tx) => {
        const seen = await tx.doc(SeenOpenings, saved.seenKey, null);
        seen.ids = saved.seenIds;
        seen.checkedAt = saved.checkedAt;
        if (saved.knownBoard) {
          (await tx.doc(KnownBoards)).boards[saved.knownBoard.name] =
            saved.knownBoard.board;
        }
      }, context);
      return { output: text(saved.output) };
    };
    const earlier = await api.memo<Check>("check", context);
    if (earlier !== undefined) return commitCheck(earlier);

    const signal = withTimeout(context.abortSignal, 30_000);
    const name = board.trim().toLowerCase();
    const direct = boardFromUrl(board);
    const known = (await api.snapshot(KnownBoards, context))?.boards[name];
    const found = await findBoard(board, direct, known, signal);
    if (!found) {
      return {
        output: text(
          `No Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee, Breezy, or Teamtailor board found for "${board}". Find the company's careers page with web_search and pass the board URL it links to.`,
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

    const matching = openings
      .filter((o) => matches(o, filter, exclude))
      .sort(newestFirst);
    const fresh = matching.filter(isNew);
    const older = matching.filter((o) => !isNew(o));
    const listed = firstCheck || all ? [...fresh, ...older] : fresh;
    const scope = [
      filter && `matching "${filter}"`,
      exclude && `without "${exclude}"`,
    ]
      .filter(Boolean)
      .map((part) => ` ${part}`)
      .join(",");
    const header = [
      `${provider} board ${slug}: ${matching.length} of ${openings.length} open roles${scope}.`,
      firstCheck
        ? "First check in this chat. Later checks list only new roles."
        : `${fresh.length} new since ${formatLocal(seen.checkedAt, env.OWNER_TIMEZONE)}.`,
    ].join(" ");
    const lines = listed
      .slice(0, MAX_LISTED)
      .map((o) => describeOpening(o, isNew(o)));
    const more =
      listed.length > MAX_LISTED
        ? [
            `${MAX_LISTED} of ${listed.length} shown. Narrow the filter to see the rest.`,
          ]
        : [];
    const stillOpen =
      firstCheck || all || older.length === 0
        ? []
        : [
            `Still open from earlier checks: ${older
              .slice(0, MAX_LISTED)
              .map((o) => o.title)
              .join(
                "; ",
              )}${older.length > MAX_LISTED ? `; and ${older.length - MAX_LISTED} more` : ""}. Set all to list them with links.`,
          ];
    const check: Check = {
      output: [header, ...lines, ...more, ...stillOpen].join("\n"),
      seenKey: key,
      seenIds: openings.map((o) => o.id),
      checkedAt: api.now(),
      ...(direct ? {} : { knownBoard: { name, board: { provider, slug } } }),
    };
    return commitCheck(await api.memo("check", check, context));
  },
});
