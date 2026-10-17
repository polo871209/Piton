import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { InlineKeyboardMarkup } from "grammy/types";
import {
  type ConversationId,
  type UserInput,
  createRegistry,
  defineExtension,
  Harness,
  ROOT_CONVERSATION_ID,
  section,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { PiCredentialStore } from "./agent/credentials";
import { createPitonModels, PROVIDER } from "./agent/model";
import { assistantInstructions, MASTER_INSTRUCTIONS } from "./agent/prompts";
import { createTurnTask, LOGIN_HINT, queueTurn } from "./agent/turn";

import { Jobs, listJobs, nextRunAt } from "./jobs";
import { messageInput } from "./telegram/attachments";
import {
  type Message,
  registerBot,
  sendReply,
  telegram,
  type Update,
  type User,
} from "./telegram/api";
import {
  Assistants,
  type BotKey,
  type ChatTarget,
  HandledUpdates,
  type ManagedBotId,
  markHandled,
  PendingAssistants,
  suggestedUsername,
  takePending,
} from "./telegram/bots";
import {
  ASSISTANT_COMMANDS,
  helpText,
  MASTER_COMMANDS,
  parseCommand,
} from "./telegram/commands";
import { streamDrafts } from "./telegram/drafts";
import { TOOLS } from "./tools";

const TOKEN_REFRESH_MARGIN_MS = 15 * 60_000;
const TOKEN_RETRY_DELAY_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_KEEPALIVE_MS = 30_000;
const RECOVERY_ALARM_DELAY_MS = 60_000;

const kualaLumpurClock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Kuala_Lumpur",
  dateStyle: "short",
  timeStyle: "short",
});

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined
    ? error.message
    : `${error.message}: ${errorText(error.cause)}`;
}

export class Piton extends DurableObject<Env> {
  #harness!: Harness;
  #models!: MutableModels;
  #managerUsername?: string;
  #submitLoginCode?: (code: string) => void;
  #alarmUpdate: Promise<void> = Promise.resolve();
  readonly #alarmTaskWatches = new Set<TaskId>();
  readonly #turnTask = createTurnTask((bot) => this.#tokenFor(bot));
  readonly #credentials = new PiCredentialStore(() => this.#harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => this.#initialize());
  }

  async #initialize() {
    const models = createPitonModels(this.#credentials);
    this.#models = models;

    const extension = defineExtension({
      name: "piton",
      tools: TOOLS,
      tasks: [this.#turnTask],
      sections: [
        section(
          "clock",
          () =>
            `Current time: ${kualaLumpurClock.format(new Date())} in Kuala Lumpur (UTC+8). The owner lives there, so give times in UTC+8.`,
          { tag: false },
        ),
      ],
    });
    const registry = createRegistry();
    registry.install(extension);

    const harness = await Harness.open(
      await openDurableObjectSqliteStorage(this.ctx.storage),
      {
        models,
        registry,
        settings: {
          extensions: [extension],
          // Retention timers keep the Durable Object awake.
          documentRetentionMs: 0,
        },
        onReport: (error) => console.error("Pi background task failed", error),
      },
      context,
    );
    void harness.closed.then((end) => {
      if (end.reason === "failed") this.ctx.abort("Pi harness failed");
    });

    try {
      this.#harness = harness;
      await harness.root(context);
      await this.#refreshAlarm();
    } catch (error) {
      await harness.close(context);
      throw error;
    }
  }

  override async alarm() {
    await this.#refreshToken();
    await this.#runDueJobs();
    await this.#refreshAlarm();
  }

  async #runDueJobs() {
    const now = Date.now();
    const doc = await this.#harness.snapshot(Jobs, context);
    const due = doc?.jobs.filter((job) => job.nextRunAt <= now) ?? [];
    if (due.length === 0) return;
    const owner = Number(this.env.TELEGRAM_OWNER_ID);
    const instructions = new Map(
      await Promise.all(
        due.map(
          async (job) =>
            [job.bot, await this.#instructionsFor(job.bot)] as const,
        ),
      ),
    );
    await this.#harness.commit(async (tx) => {
      const jobs = (await tx.doc(Jobs)).jobs;
      for (const job of jobs) {
        if (job.nextRunAt > now) continue;
        await queueTurn(tx, this.#turnTask, {
          conversationId: job.conversationId as ConversationId,
          requestId: `job:${job.id}:${job.nextRunAt}`,
          content: `Scheduled job ${job.id} is due. Do this now, then reply with the result in at most 5 lines: ${job.instruction}`,
          target: { bot: job.bot, chatId: owner },
          instructions: instructions.get(job.bot) ?? "",
        });
        job.nextRunAt = nextRunAt(job, now);
      }
    }, context);
  }

  async #tokenFor(bot: BotKey) {
    if (bot === "main") return this.env.TELEGRAM_BOT_TOKEN;
    const assistant = await this.#harness.snapshot(Assistants, bot, context);
    if (!assistant?.token) throw new Error(`No token for bot ${bot}`);
    return assistant.token;
  }

  async #conversationFor(bot: BotKey) {
    if (bot === "main") return ROOT_CONVERSATION_ID;
    const assistant = await this.#harness.snapshot(Assistants, bot, context);
    return assistant?.conversationId
      ? (assistant.conversationId as ConversationId)
      : undefined;
  }

  async #instructionsFor(bot: BotKey) {
    if (bot === "main") return MASTER_INSTRUCTIONS;
    const assistant = await this.#harness.snapshot(Assistants, bot, context);
    const name = assistant?.name || assistant?.username || "Assistant";
    return assistantInstructions(name, assistant?.job || name);
  }

  #markHandled(bot: BotKey, updateId: number) {
    return this.#harness.commit(
      (tx) => markHandled(tx, bot, updateId),
      context,
    );
  }

  async #reply(
    bot: BotKey,
    chatId: number,
    markdown: string,
    markup?: InlineKeyboardMarkup,
  ) {
    await sendReply(await this.#tokenFor(bot), chatId, markdown, markup);
  }

  async #refreshToken() {
    const credential = await this.#credentials.read(PROVIDER);
    if (credential?.type !== "oauth") return;
    if (credential.expires - Date.now() > TOKEN_REFRESH_MARGIN_MS) return;
    try {
      await this.#models.getAuth(PROVIDER, {
        minOAuthValidityMs: TOKEN_REFRESH_MARGIN_MS,
      });
      console.log("Anthropic token refreshed");
    } catch (error) {
      const text = errorText(error);
      console.error("Anthropic token refresh failed", text);
      if (!/invalid_grant/i.test(text)) return;
      await this.#credentials.delete(PROVIDER);
      await this.#reply(
        "main",
        Number(this.env.TELEGRAM_OWNER_ID),
        `Anthropic rejected the saved login. ${LOGIN_HINT}`,
      );
    }
  }

  async handleUpdate(update: Update, bot: BotKey, origin: string) {
    const handled = await this.#harness.snapshot(HandledUpdates, bot, context);
    if (update.update_id <= (handled?.lastUpdateId ?? 0)) return;

    if (update.managed_bot && bot === "main") {
      return this.#adoptBot(update.managed_bot.bot, update.update_id, origin);
    }

    const conversationId = await this.#conversationFor(bot);
    if (conversationId === undefined) {
      return this.#markHandled(bot, update.update_id);
    }

    if (update.stopped_message_generation) {
      return this.#stop(conversationId, bot, update.update_id);
    }

    const message = update.message;
    if (!message) return this.#markHandled(bot, update.update_id);
    const chatId = message.chat.id;
    const text = message.text ?? "";
    const command = parseCommand(text);
    if (text && !command && this.#submitLoginCode && bot === "main") {
      return this.#acceptLoginCode(message, text.trim(), update.update_id);
    }
    switch (command?.name) {
      case "login":
        return bot === "main"
          ? this.#login(chatId, update.update_id)
          : this.#onlyInMaster(bot, chatId, "/login", update.update_id);
      case "new":
        return bot === "main"
          ? this.#requestAssistant(chatId, command.argument, update.update_id)
          : this.#onlyInMaster(bot, chatId, "/new", update.update_id);
      case "reset":
        return this.#reset(conversationId, bot, chatId, update.update_id);
      case "stop":
        return this.#stop(conversationId, bot, update.update_id);
      case "jobs": {
        await this.#markHandled(bot, update.update_id);
        const doc = await this.#harness.snapshot(Jobs, context);
        await this.#reply(
          bot,
          chatId,
          listJobs(doc?.jobs ?? [], conversationId),
        );
        return;
      }
      case "start":
      case "help":
        await this.#markHandled(bot, update.update_id);
        await this.#reply(
          bot,
          chatId,
          helpText(bot === "main" ? MASTER_COMMANDS : ASSISTANT_COMMANDS),
        );
        return;
      default: {
        const input = await messageInput(await this.#tokenFor(bot), message);
        if (input === undefined) {
          await this.#markHandled(bot, update.update_id);
          await this.#reply(bot, chatId, "I read text, photos, and files.");
          return;
        }
        return this.#startTurn(
          conversationId,
          { bot, chatId },
          input,
          update.update_id,
        );
      }
    }
  }

  async #onlyInMaster(
    bot: BotKey,
    chatId: number,
    command: string,
    updateId: number,
  ) {
    await this.#markHandled(bot, updateId);
    await this.#reply(
      bot,
      chatId,
      `Send ${command} to @${await this.#managerName()}.`,
    );
  }

  async #managerName() {
    this.#managerUsername ??= (
      await telegram(this.env.TELEGRAM_BOT_TOKEN).getMe()
    ).username;
    return this.#managerUsername ?? "the master bot";
  }

  async #requestAssistant(chatId: number, job: string, updateId: number) {
    const name =
      (job.split(/[.,:;\n]/)[0] ?? "").trim().slice(0, 64) || "Assistant";
    const username = suggestedUsername(name);
    await this.#harness.commit(async (tx) => {
      const pending = await tx.doc(PendingAssistants);
      pending.requests = [
        ...pending.requests.filter((r) => r.username !== username),
        { username, name, job: job || name },
      ].slice(-10);
      await markHandled(tx, "main", updateId);
    }, context);
    const link = `https://t.me/newbot/${await this.#managerName()}/${username}?name=${encodeURIComponent(name)}`;
    await this.#reply(
      "main",
      chatId,
      `Tap the button, then tap Create. Telegram suggests @${username}, and you can change the name and username first.`,
      { inline_keyboard: [[{ text: `Create "${name}"`, url: link }]] },
    );
  }

  async #adoptBot(bot: User, updateId: number, origin: string) {
    const id = String(bot.id) as ManagedBotId;
    const manager = telegram(this.env.TELEGRAM_BOT_TOKEN);
    const token = await manager.getManagedBotToken(bot.id);
    await manager.setManagedBotAccessSettings(bot.id, true);
    await registerBot(
      token,
      {
        url: `${origin}/telegram/${id}`,
        secret: this.env.TELEGRAM_WEBHOOK_SECRET,
      },
      ASSISTANT_COMMANDS,
    );
    const created = await this.#harness.commit(async (tx) => {
      const assistant = await tx.doc(Assistants, id, null);
      const isNew = assistant.conversationId === 0;
      if (isNew) {
        const pending = await tx.doc(PendingAssistants);
        const request = takePending(pending.requests, bot);
        const conversation = await tx.createConversation({
          ownership: { kind: "ownerless" },
        });
        assistant.conversationId = conversation.id;
        assistant.job = request?.job ?? bot.first_name;
      }
      assistant.name = bot.first_name;
      assistant.token = token;
      assistant.username = bot.username ?? "";
      await markHandled(tx, "main", updateId);
      return isNew;
    }, context);
    const owner = Number(this.env.TELEGRAM_OWNER_ID);
    const handle = bot.username ? `@${bot.username}` : bot.first_name;
    await this.#reply(
      "main",
      owner,
      created
        ? `Created ${handle}. Open it and send a message: https://t.me/${bot.username}`
        : `Updated the token for ${handle}.`,
    );
  }

  async #login(chatId: number, updateId: number) {
    await this.#markHandled("main", updateId);
    if (this.#submitLoginCode) {
      await this.#reply(
        "main",
        chatId,
        "A login is already waiting for its code.",
      );
      return;
    }
    const code = Promise.withResolvers<string>();
    this.#submitLoginCode = code.resolve;
    void this.#completeLogin(chatId, code.promise);
  }

  async #completeLogin(chatId: number, code: Promise<string>) {
    const failed = new AbortController();
    const signal = AbortSignal.any([
      AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      failed.signal,
    ]);
    await this.#refreshAlarm();
    try {
      await this.#models.login(PROVIDER, "oauth", {
        signal,
        prompt: async (prompt) =>
          prompt.type === "select" ? "copy_code" : code,
        notify: (event) => {
          if (event.type !== "auth_url") return;
          this.#reply(
            "main",
            chatId,
            "Sign in to Claude, then paste the code here. The link expires in **10 minutes**.",
            {
              inline_keyboard: [
                [{ text: "Sign in to Claude", url: event.url }],
              ],
            },
          ).catch((error) => failed.abort(error));
        },
      });
      await this.#reply("main", chatId, "Claude login saved.");
    } catch (error) {
      await this.#reply(
        "main",
        chatId,
        `Login failed: ${errorText(error)}`,
      ).catch((sendError) => console.error("Login failed", error, sendError));
    } finally {
      this.#submitLoginCode = undefined;
      await this.#refreshAlarm();
    }
  }

  async #acceptLoginCode(message: Message, code: string, updateId: number) {
    await this.#markHandled("main", updateId);
    this.#submitLoginCode?.(code);
    await telegram(this.env.TELEGRAM_BOT_TOKEN)
      .deleteMessage(message.chat.id, message.message_id)
      .catch((error) =>
        console.error("Could not delete the login code message", error),
      );
  }

  async #reset(
    conversationId: ConversationId,
    bot: BotKey,
    chatId: number,
    updateId: number,
  ) {
    const conversation = await this.#harness.conversation(
      conversationId,
      context,
    );
    await conversation?.reset(undefined, context);
    await this.#markHandled(bot, updateId);
    await this.#reply(bot, chatId, "Started a new session.");
  }

  async #stop(conversationId: ConversationId, bot: BotKey, updateId: number) {
    const conversation = await this.#harness.conversation(
      conversationId,
      context,
    );
    await conversation?.abort(context);
    await this.#markHandled(bot, updateId);
  }

  async #startTurn(
    conversationId: ConversationId,
    target: ChatTarget,
    content: UserInput,
    updateId: number,
  ) {
    const instructions = await this.#instructionsFor(target.bot);
    await this.#harness.commit(async (tx) => {
      await queueTurn(tx, this.#turnTask, {
        conversationId,
        requestId: `tg:${target.bot}:${updateId}`,
        content,
        target,
        instructions,
      });
      await markHandled(tx, target.bot, updateId);
    }, context);
    await this.#refreshAlarm();
    void this.#tokenFor(target.bot)
      .then((token) =>
        streamDrafts(
          this.#harness,
          conversationId,
          token,
          target.chatId,
          updateId,
        ),
      )
      .catch((error) => console.error("Draft streaming failed", error));
  }

  #refreshAlarm(): Promise<void> {
    return this.#serializeAlarmUpdate(async () => {
      const { tasks } = await this.#harness.inspect(context);
      const live = tasks.filter((task) => task.state.kind !== "blocked");
      const now = Date.now();
      const credential = await this.#credentials.read(PROVIDER);
      const tokenRefreshAt =
        credential?.type === "oauth"
          ? Math.max(
              credential.expires - TOKEN_REFRESH_MARGIN_MS,
              now + TOKEN_RETRY_DELAY_MS,
            )
          : undefined;
      const jobs = (await this.#harness.snapshot(Jobs, context))?.jobs ?? [];
      const deadlines = [
        live.length > 0 ? now + RECOVERY_ALARM_DELAY_MS : undefined,
        ...jobs.map((job) => job.nextRunAt),
        // Nothing else keeps the object in memory while the login code is pending, and the code verifier lives there.
        this.#submitLoginCode ? now + LOGIN_KEEPALIVE_MS : undefined,
        tokenRefreshAt,
      ].filter((deadline) => deadline !== undefined);
      await this.#replaceAlarm(
        deadlines.length === 0 ? undefined : Math.min(...deadlines),
      );
      // waitForTask starts Pi's scheduler, so the recovery alarm is stored first.
      for (const task of live)
        this.#refreshAlarmWhenTaskSettles(task.record.id);
    });
  }

  #serializeAlarmUpdate(operation: () => Promise<void>): Promise<void> {
    const update = this.#alarmUpdate.then(operation, operation);
    this.#alarmUpdate = update;
    return update;
  }

  #refreshAlarmWhenTaskSettles(taskId: TaskId) {
    if (this.#alarmTaskWatches.has(taskId)) return;
    this.#alarmTaskWatches.add(taskId);
    void this.#harness
      .waitForTask(taskId, context)
      .then(() => this.#refreshAlarm())
      .catch((error: unknown) =>
        console.error("Alarm refresh after task failed", taskId, error),
      )
      .finally(() => this.#alarmTaskWatches.delete(taskId));
  }

  #replaceAlarm(timestamp: number | undefined): Promise<void> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.getAlarm();
      if (timestamp === undefined) {
        if (current !== null) await transaction.deleteAlarm();
      } else if (current !== timestamp) {
        await transaction.setAlarm(timestamp);
        console.log("Alarm set for", new Date(timestamp).toISOString());
      }
    });
  }
}
