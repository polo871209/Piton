import { env } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { describeJob, type Job, Jobs, listJobs, nextRunAt } from "../jobs";
import { ChatBot } from "../telegram/bots";
import { WEEKDAYS } from "../time";

const text = (value: string) => [{ type: "text" as const, text: value }];

export const scheduleJobTool = defineTool({
  name: "schedule_job",
  description:
    "Create a recurring job for this chat. At each run time you receive the task as a new message, and your answer goes to the owner. Use it when the owner wants something done regularly, such as a morning briefing.",
  parameters: Type.Object({
    task: Type.String({
      minLength: 1,
      description:
        "What to do at each run, as one or two self-contained sentences to yourself.",
    }),
    time: Type.String({
      pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$",
      description: "Local time, 24-hour HH:MM.",
    }),
    days: Type.Optional(
      Type.Array(Type.Union(WEEKDAYS.map((day) => Type.Literal(day))), {
        uniqueItems: true,
        description: "Omit for every day.",
      }),
    ),
    timezone: Type.Optional(
      Type.String({
        description: "IANA timezone. Omit to use the owner's timezone.",
      }),
    ),
  }),
  replay: "safe",
  async execute(args, api, context) {
    const timezone = args.timezone ?? env.OWNER_TIMEZONE;
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      return { output: text(`Unknown timezone: ${timezone}`), isError: true };
    }
    const bot = (await api.snapshot(ChatBot, api.conversationId, context))?.bot;
    if (!bot) throw new Error("This chat has no bot");
    const id = await api.memo(
      "job-id",
      crypto.randomUUID().slice(0, 8),
      context,
    );
    const recurrence = { time: args.time, days: args.days ?? [], timezone };
    const job = await api.commit(async (tx) => {
      const doc = await tx.doc(Jobs);
      const existing = doc.jobs.find((j) => j.id === id);
      if (existing) return { ...existing };
      const created: Job = {
        ...recurrence,
        id,
        conversationId: api.conversationId,
        bot,
        instruction: args.task,
        nextRunAt: nextRunAt(recurrence, Date.now()),
      };
      doc.jobs.push(created);
      return created;
    }, context);
    return { output: text(`Created. ${describeJob(job)}`) };
  },
});

export const listJobsTool = defineTool({
  name: "list_jobs",
  description: "List the recurring jobs of this chat.",
  parameters: Type.Object({}),
  replay: "safe",
  async execute(_args, api, context) {
    const doc = await api.snapshot(Jobs, context);
    return { output: text(listJobs(doc?.jobs ?? [], api.conversationId)) };
  },
});

export const cancelJobTool = defineTool({
  name: "cancel_job",
  description:
    "Cancel a recurring job of this chat by its ID. To change a job, cancel it and create a new one.",
  parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
  replay: "safe",
  async execute({ id }, api, context) {
    const removed = await api.commit(async (tx) => {
      const doc = await tx.doc(Jobs);
      const index = doc.jobs.findIndex(
        (job) => job.id === id && job.conversationId === api.conversationId,
      );
      if (index === -1) return false;
      doc.jobs.splice(index, 1);
      return true;
    }, context);
    return {
      output: text(
        removed ? `Cancelled job ${id}.` : `No job ${id} in this chat.`,
      ),
    };
  },
});
