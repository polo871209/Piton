export type Opening = {
  id: string;
  title: string;
  location: string;
  url: string;
  postedOn?: string;
};

const SMARTRECRUITERS_PAGE = 100;
const SMARTRECRUITERS_MAX_PAGES = 10;

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
        first_published?: string;
        updated_at?: string;
      }[];
    };
    return jobs.map(
      (job): Opening => ({
        id: String(job.id),
        title: job.title.trim(),
        location: job.location?.name ?? "",
        url: job.absolute_url,
        postedOn: isoDay(job.first_published ?? job.updated_at),
      }),
    );
  },
  Lever: async (slug: string, signal: AbortSignal) => {
    const path = `/v0/postings/${slug}?mode=json`;
    // Lever's EU deployment is separate, and the US API answers 404 for its boards.
    const body = await fetchBoard(`https://api.lever.co${path}`, signal).catch(
      (error: unknown) => {
        if (!(error instanceof BoardNotFound)) throw error;
        return fetchBoard(`https://api.eu.lever.co${path}`, signal);
      },
    );
    return (
      body as {
        id: string;
        text: string;
        categories?: { location?: string; allLocations?: string[] };
        hostedUrl: string;
        createdAt?: number;
      }[]
    ).map(
      (job): Opening => ({
        id: job.id,
        title: job.text.trim(),
        location:
          job.categories?.allLocations?.join(" / ") ??
          job.categories?.location ??
          "",
        url: job.hostedUrl,
        postedOn: isoDay(job.createdAt),
      }),
    );
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
        publishedAt?: string;
      }[];
    };
    return jobs
      .filter((job) => job.isListed !== false)
      .map(
        (job): Opening => ({
          id: job.id,
          title: job.title.trim(),
          location: joinPlaces([
            job.location,
            ...(job.secondaryLocations ?? []).map((l) => l.location),
          ]),
          url: job.jobUrl,
          postedOn: isoDay(job.publishedAt),
        }),
      );
  },
  SmartRecruiters: async (slug: string, signal: AbortSignal) => {
    type Posting = {
      id: string;
      name: string;
      releasedDate?: string;
      location?: { fullLocation?: string; remote?: boolean };
    };
    const postings: Posting[] = [];
    for (let page = 0; page < SMARTRECRUITERS_MAX_PAGES; page++) {
      const { content = [], totalFound = 0 } = (await fetchBoard(
        `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SMARTRECRUITERS_PAGE}&offset=${page * SMARTRECRUITERS_PAGE}`,
        signal,
      )) as { content?: Posting[]; totalFound?: number };
      // SmartRecruiters answers an unknown company with an empty list, not a 404.
      if (totalFound === 0) throw new BoardNotFound();
      postings.push(...content);
      if (postings.length >= totalFound || content.length === 0) break;
    }
    return postings.map(
      (job): Opening => ({
        id: job.id,
        title: job.name.trim(),
        location: joinPlaces([
          job.location?.fullLocation,
          job.location?.remote ? "Remote" : undefined,
        ]),
        url: `https://jobs.smartrecruiters.com/${slug}/${job.id}`,
        postedOn: isoDay(job.releasedDate),
      }),
    );
  },
  Workable: async (slug: string, signal: AbortSignal) => {
    const { jobs = [] } = (await fetchBoard(
      `https://apply.workable.com/api/v1/widget/accounts/${slug}`,
      signal,
    )) as {
      jobs?: {
        shortcode: string;
        title: string;
        telecommuting?: boolean;
        locations?: { city?: string; country?: string; hidden?: boolean }[];
        published_on?: string;
      }[];
    };
    return jobs.map(
      (job): Opening => ({
        id: job.shortcode,
        title: job.title.trim(),
        location: joinPlaces([
          ...(job.locations ?? [])
            .filter((place) => !place.hidden)
            .map((place) => joinPlaces([place.city, place.country], ", ")),
          job.telecommuting ? "Remote" : undefined,
        ]),
        url: `https://apply.workable.com/${slug}/j/${job.shortcode}/`,
        postedOn: isoDay(job.published_on),
      }),
    );
  },
  Recruitee: async (slug: string, signal: AbortSignal) => {
    const { offers = [] } = (await fetchBoard(
      `https://${slug}.recruitee.com/api/offers/`,
      signal,
    )) as {
      offers?: {
        slug: string;
        title: string;
        location?: string;
        remote?: boolean;
        careers_url: string;
        published_at?: string;
      }[];
    };
    return offers.map(
      (job): Opening => ({
        id: job.slug,
        title: job.title.trim(),
        location: joinPlaces([job.location, job.remote ? "Remote" : undefined]),
        url: job.careers_url,
        postedOn: isoDay(job.published_at),
      }),
    );
  },
  Breezy: async (slug: string, signal: AbortSignal) => {
    const body = (await fetchBoard(
      `https://${slug}.breezy.hr/json`,
      signal,
    )) as {
      id: string;
      name: string;
      url: string;
      published_date?: string;
      location?: { name?: string; is_remote?: boolean };
    }[];
    return body.map(
      (job): Opening => ({
        id: job.id,
        title: job.name.trim(),
        location: joinPlaces([
          job.location?.name,
          job.location?.is_remote ? "Remote" : undefined,
        ]),
        url: job.url,
        postedOn: isoDay(job.published_date),
      }),
    );
  },
  Teamtailor: async (site: string, signal: AbortSignal) => {
    const host = site.includes(".") ? site : `${site}.teamtailor.com`;
    const { items = [] } = (await fetchBoard(
      `https://${host}/jobs.json`,
      signal,
    )) as {
      items?: {
        id: string;
        title: string;
        url: string;
        date_published?: string;
        _jobposting?: {
          jobLocation?: {
            address?: { addressLocality?: string; addressCountry?: string };
          }[];
          jobLocationType?: string;
        };
      }[];
    };
    return items.map((job): Opening => {
      const posting = job._jobposting;
      return {
        id: job.id,
        title: job.title.trim(),
        location: joinPlaces([
          ...(posting?.jobLocation ?? []).map(({ address }) =>
            joinPlaces(
              [address?.addressLocality, address?.addressCountry],
              ", ",
            ),
          ),
          posting?.jobLocationType === "TELECOMMUTE" ? "Remote" : undefined,
        ]),
        url: job.url,
        postedOn: isoDay(job.date_published),
      };
    });
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
  if (!/json/.test(response.headers.get("content-type") ?? "")) {
    throw new BoardNotFound();
  }
  return response.json<unknown>();
}

const joinPlaces = (places: (string | undefined)[], separator = " / ") =>
  places.filter(Boolean).join(separator);

function isoDay(value: string | number | undefined) {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toISOString().slice(0, 10);
}

type PostingAddress = { provider: Provider; slug: string; id: string };

const POSTING_URLS: [RegExp, Provider][] = [
  [/greenhouse\.io\/([\w-]+)\/jobs\/(\d+)/i, "Greenhouse"],
  [/jobs\.(?:eu\.)?lever\.co\/([\w-]+)\/([0-9a-f-]{36})/i, "Lever"],
  [/jobs\.ashbyhq\.com\/([\w.-]+)\/([0-9a-f-]{36})/i, "Ashby"],
  [/jobs\.smartrecruiters\.com\/([\w-]+)\/(\d+)/i, "SmartRecruiters"],
  [/apply\.workable\.com\/([\w-]+)\/j\/([0-9a-f]{10})/i, "Workable"],
  [/\/\/([\w-]+)\.recruitee\.com\/o\/([\w-]+)/i, "Recruitee"],
  [/\/\/([\w-]+)\.breezy\.hr\/p\/([0-9a-f]{12})/i, "Breezy"],
];

function postingAddress(url: string): PostingAddress | undefined {
  for (const [pattern, provider] of POSTING_URLS) {
    const [, slug, id] = pattern.exec(url) ?? [];
    if (slug && id) return { provider, slug, id };
  }
  return undefined;
}

function embeddedGreenhouseAddress(url: string): PostingAddress | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  const id = parsed.searchParams.get("gh_jid");
  const labels = parsed.hostname.split(".");
  const slug = labels.at(-2);
  if (!id || !slug) return undefined;
  return { provider: "Greenhouse", slug, id };
}

/**
 * The board entry of a posting URL from a supported job board, or a company page that embeds a Greenhouse posting.
 * Null if a job board posting URL is no longer listed. Undefined if the URL belongs to no known board, or if the
 * embedded posting is not found, because its board is guessed from the host name.
 */
export async function listedOpening(url: string, signal: AbortSignal) {
  const direct = postingAddress(url);
  const address = direct ?? embeddedGreenhouseAddress(url);
  if (!address) return undefined;
  const notListed = direct ? null : undefined;
  try {
    const openings = await PROVIDERS[address.provider](address.slug, signal);
    const id = address.id.toLowerCase();
    return openings.find((o) => o.id.toLowerCase() === id) ?? notListed;
  } catch (error) {
    if (!(error instanceof BoardNotFound)) throw error;
    return notListed;
  }
}
