import { env } from "cloudflare:workers";
import { defineDoc } from "@earendil-works/pi-durable";
import type { BotKey } from "./telegram/bots";
import {
  formatLocal,
  localParts,
  WEEKDAYS,
  type Weekday,
  zonedTime,
} from "./time";

export type Recurrence = {
  time: string;
  days: Weekday[];
  timezone: string;
};

export type Job = Recurrence & {
  id: string;
  conversationId: number;
  bot: BotKey;
  instruction: string;
  nextRunAt: number;
};

export const Jobs = defineDoc<{ jobs: Job[] }>({
  kind: "piton.jobs",
  version: 1,
  scope: "session",
  initial: () => ({ jobs: [] }),
  checkpointWhen: () => true,
});

export function nextRunAt(recurrence: Recurrence, after: number) {
  const [hour, minute] = recurrence.time.split(":").map(Number);
  const today = localParts(after, recurrence.timezone);
  for (let offset = 0; offset <= 7; offset++) {
    const date = new Date(
      Date.UTC(today.year, today.month - 1, today.day + offset),
    );
    const weekday = WEEKDAYS[date.getUTCDay()]!;
    if (recurrence.days.length > 0 && !recurrence.days.includes(weekday)) {
      continue;
    }
    const wallClock = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      hour,
      minute,
    );
    const runAt = zonedTime(wallClock, recurrence.timezone);
    if (runAt > after) return runAt;
  }
  throw new Error("The job has no run time in the next 7 days");
}

const WORKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

function describeDays(days: readonly Weekday[]) {
  if (days.length === 0 || days.length === 7) return "Every day";
  if (days.length === 5 && WORKDAYS.every((d) => days.includes(d))) {
    return "Weekdays";
  }
  return WEEKDAYS.filter((d) => days.includes(d))
    .map((d) => d[0]!.toUpperCase() + d.slice(1))
    .join(", ");
}

export function describeJob(job: Job) {
  const next = formatLocal(job.nextRunAt, job.timezone);
  const zone = job.timezone === env.OWNER_TIMEZONE ? "" : ` ${job.timezone}`;
  return `**${describeDays(job.days)} at ${job.time}${zone}** · next ${next}
<details><summary>Task · job ${job.id}</summary>

${job.instruction}

</details>`;
}

export function listJobs(jobs: readonly Job[], conversationId: number) {
  const own = jobs.filter((job) => job.conversationId === conversationId);
  return own.length === 0 ? "0 jobs." : own.map(describeJob).join("\n\n");
}
