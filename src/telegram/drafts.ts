import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  type AgentEvent,
  type ConversationId,
  type EntryRecord,
  type Harness,
  type JsonObject,
  watchEvents,
} from "@earendil-works/pi-durable";
import { errorText } from "../errors";
import { sendDraft } from "./api";

const DRAFT_INTERVAL_MS = 3_000;
// Telegram drops a draft 30 seconds after its last update.
const DRAFT_KEEPALIVE_MS = 20_000;

const MAX_STEPS = 6;
const THINKING_TAIL_CHARS = 280;
const DETAIL_CHARS = 60;

type Step = { label: string; state: "running" | "done" | "failed" };

const clip = (text: string, size: number) =>
  text.length > size ? `${text.slice(0, size - 1)}…` : text;

const escapeMarkdown = (text: string) =>
  text.replace(/[\\`*_[\]()~>#|<]/g, "\\$&");

function shortUrl(url: string) {
  try {
    const { host, pathname } = new URL(url);
    return `${host.replace(/^www\./, "")}${pathname === "/" ? "" : pathname}`;
  } catch {
    return url;
  }
}

function stepLabel(toolName: string, args: JsonObject) {
  const text = (key: string) =>
    typeof args[key] === "string" ? args[key] : undefined;
  const detail = (value: string | undefined) =>
    value ? `: ${escapeMarkdown(clip(value, DETAIL_CHARS))}` : "";
  switch (toolName) {
    case "web_search":
      return `Searching${detail(text("query"))}`;
    case "fetch_page": {
      const urls = Array.isArray(args.urls) ? args.urls.map(String) : [];
      const more = urls.length > 1 ? ` and ${urls.length - 1} more` : "";
      return `Reading${detail(urls[0] && shortUrl(urls[0]))}${more}`;
    }
    case "company_jobs": {
      const board = text("board");
      return `Checking job board${detail(board && shortUrl(board))}`;
    }
    case "schedule_job":
      return `Scheduling${detail(text("task"))}`;
    case "list_jobs":
      return "Listing jobs";
    case "cancel_job":
      return "Cancelling a job";
    case "job_tracker":
      return "Job tracker";
    case "photo_frame":
      return `Photo frame${detail(text("action"))}`;
    case "tool_search":
      return "Loading a tool";
    default:
      return escapeMarkdown(toolName);
  }
}

function failed(entry: EntryRecord | undefined) {
  const result = entry?.model?.[0];
  return result?.role === "toolResult" && result.isError;
}

function renderSteps(steps: Step[]) {
  const hidden = steps.length - MAX_STEPS;
  const shown = steps.slice(-MAX_STEPS).map(({ label, state }) => {
    if (state === "running") return `- ${label}…`;
    if (state === "failed") return `- ${label} (failed)`;
    return `- ${label}`;
  });
  return [hidden > 0 ? `- ${hidden} earlier steps` : "", ...shown]
    .filter(Boolean)
    .join("\n");
}

function renderThinking(thinking: string) {
  const paragraph =
    thinking
      .trim()
      .split(/\n\s*\n/)
      .pop() ?? "";
  const tail =
    paragraph.length > THINKING_TAIL_CHARS
      ? `…${paragraph.slice(-THINKING_TAIL_CHARS)}`
      : paragraph;
  return tail ? `> ${escapeMarkdown(tail.replace(/\s+/g, " "))}` : "";
}

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
  let thinking = "";
  let steps: Step[] = [];
  const running = new Map<string, Step>();
  let dirty = true;
  let sending = false;
  let sentAt = 0;

  const send = async () => {
    sending = true;
    dirty = false;
    sentAt = Date.now();
    const draft = [
      renderSteps(steps),
      text ? text.trim() : renderThinking(thinking),
    ]
      .filter(Boolean)
      .join("\n\n");
    await sendDraft(token, chatId, draftId, draft)
      .catch((error) =>
        console.error("sendMessageDraft failed", errorText(error)),
      )
      .finally(() => {
        sending = false;
      });
  };

  const apply = (event: AgentEvent) => {
    switch (event.type) {
      case "run_start":
        draftId = ++lastDraftId;
        text = "";
        thinking = "";
        steps = [];
        running.clear();
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          text = "";
          thinking = "";
        }
        break;
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "text_delta") text += change.delta;
          if (change.type === "thinking_delta") thinking += change.delta;
        }
        break;
      case "tool_execution_start": {
        if (event.parentToolCallId) return;
        const step: Step = {
          label: stepLabel(event.toolName, event.args),
          state: "running",
        };
        steps.push(step);
        running.set(event.toolCallId, step);
        break;
      }
      case "tool_execution_end": {
        const step = running.get(event.toolCallId);
        if (!step) return;
        step.state = failed(event.entry) ? "failed" : "done";
        running.delete(event.toolCallId);
        break;
      }
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
