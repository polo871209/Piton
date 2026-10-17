import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type Harness,
  watchEvents,
} from "@earendil-works/pi-durable";
import { sendDraft } from "./api";

const DRAFT_INTERVAL_MS = 1_000;
const DRAFT_TIMEOUT_MS = 15 * 60_000;

export async function streamDrafts(
  harness: Harness,
  conversationId: ConversationId,
  token: string,
  chatId: number,
  draftId: number,
) {
  const stream = await watchEvents(harness, conversationId, context);
  const timeout = setTimeout(() => void stream.stop(), DRAFT_TIMEOUT_MS);
  void stream.closed.finally(() => clearTimeout(timeout));
  await sendDraft(token, chatId, draftId, "");
  let text = "";
  let sentAt = 0;
  stream.start(async (events) => {
    for (const event of events) {
      if (event.type === "run_end") {
        void stream.stop();
        return;
      }
      if (event.type === "message_start") text = "";
      if (event.type !== "message_update") continue;
      for (const change of event.changes) {
        if (change.type === "text_delta") text += change.delta;
      }
    }
    if (!text || Date.now() - sentAt < DRAFT_INTERVAL_MS) return;
    sentAt = Date.now();
    await sendDraft(token, chatId, draftId, text).catch((error) =>
      console.error("sendMessageDraft failed", error),
    );
  });
}
