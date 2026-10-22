import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  type AgentEvent,
  type ConversationId,
  type Harness,
  watchEvents,
} from "@earendil-works/pi-durable";
import { sendDraft } from "./api";

const DRAFT_INTERVAL_MS = 1_000;
// Telegram drops a draft 30 seconds after its last update.
const DRAFT_KEEPALIVE_MS = 20_000;

const TOOL_STATUS: Partial<Record<string, string>> = {
  web_search: "Searching the web",
  fetch_page: "Reading pages",
  company_jobs: "Checking job boards",
  schedule_job: "Scheduling the job",
  list_jobs: "Listing jobs",
  cancel_job: "Cancelling the job",
};

let lastDraftId = Date.now() % 2 ** 30;

async function watchDrafts(
  harness: Harness,
  conversationId: ConversationId,
  token: string,
  chatId: number,
) {
  const stream = await watchEvents(harness, conversationId, context);
  let draftId = ++lastDraftId;
  let text = "";
  const tools = new Map<string, string>();
  let dirty = true;
  let sending = false;
  let sentAt = 0;

  const send = async () => {
    sending = true;
    dirty = false;
    sentAt = Date.now();
    const status = [...new Set(tools.values())]
      .map((name) => `_${TOOL_STATUS[name] ?? name}…_`)
      .join("\n");
    await sendDraft(
      token,
      chatId,
      draftId,
      [text.trim(), status].filter(Boolean).join("\n\n"),
    )
      .catch((error) => console.error("sendMessageDraft failed", error))
      .finally(() => {
        sending = false;
      });
  };

  const apply = (event: AgentEvent) => {
    switch (event.type) {
      case "run_start":
        draftId = ++lastDraftId;
        text = "";
        break;
      case "message_start":
        if (event.message.role === "assistant") text = "";
        break;
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "text_delta") text += change.delta;
        }
        break;
      case "tool_execution_start":
        if (!event.parentToolCallId)
          tools.set(event.toolCallId, event.toolName);
        break;
      case "tool_execution_end":
        tools.delete(event.toolCallId);
        break;
      default:
        return;
    }
    dirty = true;
  };

  const timer = setInterval(() => {
    if (sending) return;
    if (dirty || Date.now() - sentAt >= DRAFT_KEEPALIVE_MS) void send();
  }, DRAFT_INTERVAL_MS);
  stream.start(async (events) => events.forEach(apply));
  void send();

  return async () => {
    clearInterval(timer);
    await stream.stop();
  };
}

/** Streams a conversation's reply as a Telegram draft while at least one turn holds it. */
export class DraftStreams {
  readonly #harness: () => Harness;
  readonly #watches = new Map<
    ConversationId,
    { holders: number; stop: Promise<(() => Promise<void>) | undefined> }
  >();

  constructor(harness: () => Harness) {
    this.#harness = harness;
  }

  /** Returns the release function. The draft stops when the last holder releases. */
  hold(conversationId: ConversationId, token: string, chatId: number) {
    let watch = this.#watches.get(conversationId);
    if (!watch) {
      watch = {
        holders: 0,
        stop: watchDrafts(this.#harness(), conversationId, token, chatId).catch(
          (error) => {
            console.error("Draft streaming failed", error);
            return undefined;
          },
        ),
      };
      this.#watches.set(conversationId, watch);
    }
    watch.holders += 1;
    const held = watch;
    return () => {
      held.holders -= 1;
      if (held.holders > 0) return;
      if (this.#watches.get(conversationId) === held) {
        this.#watches.delete(conversationId);
      }
      void held.stop
        .then((stop) => stop?.())
        .catch((error) => console.error("Draft stream stop failed", error));
    };
  }
}
