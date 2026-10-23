import {
  defineDoc,
  defineDocFamily,
  type Tx,
} from "@earendil-works/pi-durable";
import type { User } from "./api";

export type ManagedBotId = `${number}`;
export type BotKey = "main" | ManagedBotId;

export type ChatTarget = { readonly bot: BotKey; readonly chatId: number };

export const ChatBot = defineDoc<{ bot: BotKey | "" }>({
  kind: "piton.chat-bot",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ bot: "" }),
  checkpointWhen: () => true,
});

export const HandledUpdates = defineDocFamily<{ lastUpdateId: number }, null>({
  family: true,
  kind: "piton.bot-updates",
  version: 1,
  scope: "session",
  initial: () => ({ lastUpdateId: 0 }),
  checkpointWhen: () => true,
});

export const Assistants = defineDocFamily<
  {
    conversationId: number;
    token: string;
    username: string;
    name: string;
    job: string;
  },
  null
>({
  family: true,
  kind: "piton.assistant",
  version: 1,
  scope: "session",
  initial: () => ({
    conversationId: 0,
    token: "",
    username: "",
    name: "",
    job: "",
  }),
  checkpointWhen: () => true,
});

type PendingAssistant = { username: string; name: string; job: string };

export const PendingAssistants = defineDoc<{ requests: PendingAssistant[] }>({
  kind: "piton.pending-assistants",
  version: 1,
  scope: "session",
  initial: () => ({ requests: [] }),
  checkpointWhen: () => true,
});

export function suggestedUsername(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 13)
    .replace(/^_+|_+$/g, "");
  return slug ? `pitonassistant_${slug}_bot` : "pitonassistant_bot";
}

export function takePending(
  requests: PendingAssistant[],
  bot: User,
): PendingAssistant | undefined {
  const username = bot.username?.toLowerCase();
  const index = [
    requests.findIndex((r) => r.username.toLowerCase() === username),
    requests.findIndex((r) => r.name === bot.first_name),
    requests.length - 1,
  ].find((i) => i >= 0);
  return index === undefined ? undefined : requests.splice(index, 1)[0];
}

export async function markHandled(tx: Tx, bot: BotKey, updateId: number) {
  const handled = await tx.doc(HandledUpdates, bot, null);
  handled.lastUpdateId = updateId;
}
