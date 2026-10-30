import type { Context } from "@earendil-works/chord";
import {
  type ConversationId,
  configure,
  defineTask,
  type EntryId,
  type TaskRuntime,
  type Tx,
  type UserInput,
} from "@earendil-works/pi-durable";
import { sendReply } from "../telegram/api";
import { type BotKey, ChatBot, type ChatTarget } from "../telegram/bots";
import type { DraftStreams } from "../telegram/drafts";
import { AGENT } from "./model";

type TurnInput = {
  readonly conversationId: ConversationId;
  readonly requestId: string;
  readonly content: UserInput;
  readonly target: ChatTarget;
};

const MAX_SEND_ATTEMPTS = 5;

export const LOGIN_HINT =
  "Send /login to the master bot to sign in to Claude again.";

const AUTH_ERROR =
  /not configured|no api key|authentication_error|invalid_grant|oauth|\b401\b|unauthorized/i;

function unansweredText(reason: string, detail: unknown) {
  const text = `${reason} ${JSON.stringify(detail ?? "")}`;
  if (AUTH_ERROR.test(text))
    return `Claude is not signed in, or it rejected the login. ${LOGIN_HINT}`;
  return `(no answer: ${reason})`;
}

type TurnState =
  | { phase: "answer" }
  | { phase: "send"; reply: string; attempt: number };

async function answerText(
  runtime: TaskRuntime<TurnInput, TurnState, null, object>,
  answer: EntryId,
  context: Context,
) {
  const entry = await runtime.entry(answer, context);
  const message = entry?.model?.[0];
  const text =
    message?.role === "assistant"
      ? message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
          .trim()
      : "";
  return text || "(empty answer)";
}

export function createTurnTask(
  tokenFor: (bot: BotKey) => Promise<string>,
  drafts: DraftStreams,
) {
  return defineTask<TurnInput, TurnState, null>({
    name: "piton.telegram-turn",
    version: 1,
    initial: () => ({ phase: "answer" }),
    phases: {
      answer: async (task, runtime, context) => {
        const { conversationId, requestId, content } = task.input;
        const conversation = await runtime.conversation(
          conversationId,
          context,
        );
        if (conversation === undefined) {
          throw new Error(`Conversation ${conversationId} is missing`);
        }
        const { bot, chatId } = task.input.target;
        const release = drafts.hold(
          conversationId,
          await tokenFor(bot),
          chatId,
        );
        const settled = await conversation
          .submit(
            { type: "input", content, requestId, whenBusy: "followUp" },
            context,
          )
          .then((submission) => submission.wait(context))
          .finally(release);
        const reply =
          settled.status === "done" && settled.type === "input"
            ? await answerText(runtime, settled.answer, context)
            : unansweredText(settled.reason ?? settled.status, settled.detail);
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: { phase: "send", reply, attempt: 1 },
          }),
          context,
        );
      },
      send: async (task, runtime, context) => {
        const { reply, attempt } = task.state.checkpoint;
        try {
          const { bot, chatId } = task.input.target;
          await sendReply(await tokenFor(bot), chatId, reply);
        } catch (error) {
          if (attempt >= MAX_SEND_ATTEMPTS) throw error;
          await runtime.sleepUntil(
            runtime.now() + 2 ** attempt * 1_000,
            { phase: "send", reply, attempt: attempt + 1 },
            context,
          );
          return;
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });
}

export async function queueTurn(
  tx: Tx,
  turnTask: ReturnType<typeof createTurnTask>,
  turn: {
    conversationId: ConversationId;
    requestId: string;
    content: UserInput;
    target: ChatTarget;
    instructions: string;
  },
) {
  const { conversationId, instructions, ...input } = turn;
  await configure(tx, conversationId, { ...AGENT, instructions });
  (await tx.doc(ChatBot, conversationId)).bot = turn.target.bot;
  await tx.createTask(
    turnTask,
    { conversationId, ...input },
    { ownership: { kind: "conversation" }, conversationId, background: true },
  );
}
