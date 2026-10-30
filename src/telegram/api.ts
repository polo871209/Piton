import type { BotCommand, InlineKeyboardMarkup } from "grammy/types";
import { Api, GrammyError } from "grammy/web";

export type { BotCommand, Message, Update, User } from "grammy/types";

const MAX_RICH_LENGTH = 32_768;
const MAX_PLAIN_LENGTH = 4_096;

export const telegram = (token: string) => new Api(token);

function chunks(text: string, size: number) {
  const parts: string[] = [];
  for (let start = 0; start < text.length; start += size) {
    parts.push(text.slice(start, start + size));
  }
  return parts;
}

function plainText(markdown: string) {
  return markdown
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1 ($2)")
    .replace(/<\/?(details|summary)>/g, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/^#{1,6}\s+/gm, "");
}

/** Sends Markdown as a Telegram rich message, or as plain text if Telegram rejects the Markdown. */
export async function sendReply(
  token: string,
  chatId: number,
  markdown: string,
  replyMarkup?: InlineKeyboardMarkup,
) {
  const api = telegram(token);
  try {
    await api.sendRichMessage(
      chatId,
      { markdown },
      {
        reply_markup: replyMarkup,
      },
    );
    return;
  } catch (error) {
    if (!(error instanceof GrammyError) || error.error_code !== 400) {
      throw error;
    }
    console.error(
      "Rich message rejected, sending plain text",
      error.description,
    );
  }
  const parts = chunks(plainText(markdown), MAX_PLAIN_LENGTH);
  for (const [index, text] of parts.entries()) {
    const last = index === parts.length - 1;
    await api.sendMessage(chatId, text, {
      ...(last && replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
}

/** An empty `markdown` shows Telegram's "Thinking…" placeholder. */
export async function sendDraft(
  token: string,
  chatId: number,
  draftId: number,
  markdown: string,
) {
  const api = telegram(token);
  if (!markdown) {
    await api.sendMessageDraft(chatId, draftId, "", { can_stop: true });
    return;
  }
  const tail = markdown.slice(-MAX_RICH_LENGTH);
  await api
    .sendRichMessageDraft(
      chatId,
      draftId,
      { markdown: tail },
      { can_stop: true },
    )
    .catch(() =>
      api.sendMessageDraft(chatId, draftId, tail.slice(-MAX_PLAIN_LENGTH), {
        can_stop: true,
      }),
    );
}

export async function registerBot(
  token: string,
  webhook: { url: string; secret: string },
  commands: readonly BotCommand[],
) {
  const api = telegram(token);
  try {
    await api.setWebhook(webhook.url, {
      secret_token: webhook.secret,
      allowed_updates: ["message", "stopped_message_generation", "managed_bot"],
      max_connections: 1,
    });
  } catch (error) {
    // GrammyError keeps the request payload, which holds the webhook secret.
    const reason = error instanceof GrammyError ? error.description : error;
    throw new Error(`setWebhook failed: ${reason}`);
  }
  await api.setMyCommands([...commands]);
}
