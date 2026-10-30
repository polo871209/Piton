import { errorText } from "./errors";
import { registerBot, sendReply, type Update } from "./telegram/api";
import type { BotKey } from "./telegram/bots";
import { MASTER_COMMANDS } from "./telegram/commands";

export { Piton } from "./piton";

function secretMatches(given: string | null, expected: string | undefined) {
  if (!given || !expected) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(given);
  const b = encoder.encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

function isFromOwner(update: Update, ownerId: string) {
  const { message, stopped_message_generation: stopped, managed_bot } = update;
  if (managed_bot) return String(managed_bot.user.id) === ownerId;
  const chat = message?.chat ?? stopped?.chat;
  const senderId = message ? message.from?.id : stopped?.chat.id;
  return (
    chat?.type === "private" &&
    String(chat.id) === ownerId &&
    String(senderId) === ownerId
  );
}

function botKeyOf(pathname: string): BotKey | undefined {
  if (pathname === "/telegram") return "main";
  const managed = /^\/telegram\/(\d+)$/.exec(pathname)?.[1];
  return managed === undefined ? undefined : `${Number(managed)}`;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    const secret = request.headers.get("x-telegram-bot-api-secret-token");
    if (!secretMatches(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("Forbidden", { status: 403 });
    }
    const { origin, pathname } = new URL(request.url);
    if (pathname === "/telegram/setup") {
      const url = `${origin}/telegram`;
      await registerBot(
        env.TELEGRAM_BOT_TOKEN,
        { url, secret: env.TELEGRAM_WEBHOOK_SECRET },
        MASTER_COMMANDS,
      );
      return Response.json({ webhook: url });
    }
    const bot = botKeyOf(pathname);
    if (bot === undefined) return new Response("Not found", { status: 404 });

    const update = await request.json<Update>();
    if (!isFromOwner(update, env.TELEGRAM_OWNER_ID)) {
      return new Response("ok");
    }
    try {
      await env.PITON.getByName("owner").handleUpdate(update, bot, origin);
    } catch (error) {
      // Telegram retries a failed update before every later one, so one bad update would block the chat.
      const message = errorText(error);
      console.error("Dropped Telegram update", bot, update.update_id, message);
      await sendReply(
        env.TELEGRAM_BOT_TOKEN,
        Number(env.TELEGRAM_OWNER_ID),
        `Piton failed on your last message and skipped it: ${message}`,
      ).catch((sendError) =>
        console.error("Could not report the dropped update", sendError),
      );
    }
    return new Response("ok");
  },
} satisfies ExportedHandler<Env>;
