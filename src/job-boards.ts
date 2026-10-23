export type Opening = {
  id: string;
  title: string;
  location: string;
  url: string;
};

export const PROVIDERS = {
  Greenhouse: async (slug: string, signal: AbortSignal) => {
    const body = await fetchBoard(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
      signal,
    );
    const { jobs = [] } = body as {
      jobs?: {
        id: number;
        title: string;
        location?: { name?: string };
        absolute_url: string;
      }[];
    };
    return jobs.map((job): Opening => ({
      id: String(job.id),
      title: job.title,
      location: job.location?.name ?? "",
      url: job.absolute_url,
    }));
  },
  Lever: async (slug: string, signal: AbortSignal) => {
    const body = await fetchBoard(
      `https://api.lever.co/v0/postings/${slug}?mode=json`,
      signal,
    );
    return (
      body as {
        id: string;
        text: string;
        categories?: { location?: string };
        hostedUrl: string;
      }[]
    ).map((job): Opening => ({
      id: job.id,
      title: job.text,
      location: job.categories?.location ?? "",
      url: job.hostedUrl,
    }));
  },
  Ashby: async (slug: string, signal: AbortSignal) => {
    const body = await fetchBoard(
      `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
      signal,
    );
    const { jobs = [] } = body as {
      jobs?: {
        id: string;
        title: string;
        location?: string;
        secondaryLocations?: { location?: string }[];
        jobUrl: string;
        isListed?: boolean;
      }[];
    };
    return jobs
      .filter((job) => job.isListed !== false)
      .map((job): Opening => ({
        id: job.id,
        title: job.title.trim(),
        location: [
          job.location,
          ...(job.secondaryLocations ?? []).map((l) => l.location),
        ]
          .filter(Boolean)
          .join(" / "),
        url: job.jobUrl,
      }));
  },
};

export type Provider = keyof typeof PROVIDERS;

export class BoardNotFound extends Error {}

async function fetchBoard(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal,
  });
  if (response.status === 404) throw new BoardNotFound();
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json<unknown>();
}

const POSTING_URLS: [RegExp, Provider][] = [
  [/greenhouse\.io\/([\w-]+)\/jobs\/(\d+)/i, "Greenhouse"],
  [/jobs\.(?:eu\.)?lever\.co\/([\w-]+)\/([0-9a-f-]{36})/i, "Lever"],
  [/jobs\.ashbyhq\.com\/([\w.-]+)\/([0-9a-f-]{36})/i, "Ashby"],
];

/** Whether a Greenhouse, Lever, or Ashby posting URL is listed on its board now. Undefined for other URLs. */
export async function postingListed(url: string, signal: AbortSignal) {
  for (const [pattern, provider] of POSTING_URLS) {
    const [, slug, id] = pattern.exec(url) ?? [];
    if (!slug || !id) continue;
    const openings = await PROVIDERS[provider](slug, signal).catch(
      (error: unknown) => {
        if (error instanceof BoardNotFound) return [];
        throw error;
      },
    );
    return openings.some((opening) => opening.id === id);
  }
  return undefined;
}
