import { exports, WorkerEntrypoint } from "cloudflare:workers";

const directFetch = globalThis.fetch;

export class Egress extends WorkerEntrypoint {
  override fetch(request: Request) {
    return directFetch(request);
  }
}

/**
 * Workers Free allows 50 external subrequests per invocation, which one agent turn exceeds. A loopback call costs one
 * of the 1,000 internal subrequests instead, and Egress makes the real request with a fresh budget.
 */
export function routeFetchThroughEgress() {
  globalThis.fetch = (input, init) =>
    exports.Egress.fetch(new Request(input, init));
}
