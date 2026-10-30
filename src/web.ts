export class TransientError extends Error {}

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function assertOk(response: Response) {
  if (response.status === 429 || response.status >= 500) {
    throw new TransientError(`HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export const withTimeout = (signal: AbortSignal | undefined, ms: number) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
    : AbortSignal.timeout(ms);

const TRACKING_PARAMETER = /^(utm_|gclid$|fbclid$|mc_|ref$|source$)/i;

/** One key per page: host without www, path without trailing slashes, and query without tracking parameters. */
export function pageKey(raw: string) {
  const url = new URL(raw);
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETER.test(name)) url.searchParams.delete(name);
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return `${host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}
