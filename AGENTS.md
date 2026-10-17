# Piton

<!-- AGENT: when adding, removing, or materially changing a model tool, update its bullet here. One bullet per item: capability and when it applies, in one concise clause. Omit implementation details. -->

Single-owner assistant on Telegram, built on [Pi Durable](https://github.com/earendil-works/pi-durable-cloudflare): one Cloudflare Worker, one Durable Object, and one bot per assistant.

## Design rules

1. **Deterministic first.** If code, a regex, or a fixed branch can do the step, do not prompt the model.
2. **Free by default.** A tool calls only free endpoints. Ask before adding anything billed per call. Cloudflare Web Search bills per search. Exa's free MCP, LinkedIn, and Workday block Worker traffic.
3. **Durable or nothing.** Work that must survive a restart runs as a Pi task in the `piton` extension, never as a dangling promise. App state, credentials included, goes through `harness.commit` and Pi documents, never `ctx.storage`.
4. **Owner only.** Only `TELEGRAM_OWNER_ID` can reach an assistant. Never log or send a token. Log only expiry times and outcomes.
5. **Say what, not how.** Model-facing tool descriptions and instructions state the capability and when to use it, never the mechanism.

## Working on Piton

- Ask before adding a runtime dependency. Call the Bot API through grammY with `telegram()` from `src/telegram/api.ts`, and send model text with `sendReply`, so it renders as rich Markdown.
- Pin Pi packages exactly (`pnpm add -E`). Read their `.d.ts` files in `node_modules` before using an API. Reference: https://github.com/earendil-works/pi-durable-cloudflare.
- Every Telegram update handler commits `markHandled` in the same Pi commit as its state change.
- Put each model tool in its own file in `src/tools/` and add it to `TOOLS` in `src/tools/index.ts`. Shared logic that is not a tool, such as `src/jobs.ts`, stays outside `src/tools/`.
- Set a tool's `replay: "safe"` only on reads and idempotent writes.
- The Durable Object has one alarm. Add every deadline to `#refreshAlarm`, and never call `setAlarm` elsewhere.
- A new secret goes in `secrets.required` in `wrangler.jsonc`, in `.mise.local.toml`, and through `wrangler secret put`.
- Use Wrangler for the Worker, secrets, and logs. Use `cf` only for APIs Wrangler lacks, such as DNS.
- To test egress from Cloudflare, such as whether a site blocks Workers, run a scratch Worker with `wrangler dev --remote`. Local `wrangler dev` uses your own IP.
- To test the deployed bot, use the `telegram` MCP server. It acts as the owner in the chat with `@pitonguide_bot`.
- After a change to `wrangler.jsonc`, run `pnpm types`. Done means `pnpm typecheck` passes.

## What the assistants can do

### Tools for the model

- **`web_search`** — searches the web for news, prices, and other facts that change, and returns the top results with title, URL, and snippet.
- **`fetch_page`** — reads web pages to confirm what search snippets miss, such as whether a job posting is open, its date, and its requirements.
- **`company_jobs`** — lists a company's open roles from its Greenhouse, Lever, or Ashby board and marks roles that are new since the last check in the chat, for watching a company for openings.
- **Attachments** — reads photos as images and PDF, Office, and text files as text, so the owner can send them as context.
- **`schedule_job`, `list_jobs`, `cancel_job`** — create, list, and cancel recurring jobs of the current chat when the owner wants something done regularly, such as a morning briefing. `/jobs` lists them without the model.
