import { env } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { defineDocFamily, defineTool } from "@earendil-works/pi-durable";

const STATUSES = [
  "applied",
  "interview",
  "offer",
  "sent",
  "dismissed",
  "rejected",
  "closed",
] as const;
type RoleStatus = (typeof STATUSES)[number];

const JOB_ID_PARAMS = /^(?:gh_jid|jid|id|jobid|job_id|job|req|reqid)$/i;

type TrackedRole = {
  key: string;
  url: string;
  company: string;
  title: string;
  status: RoleStatus;
  note: string;
  updatedAt: number;
};

const TrackedRoles = defineDocFamily<{ roles: TrackedRole[] }, null>({
  family: true,
  kind: "piton.tracked-roles",
  version: 1,
  scope: "session",
  initial: () => ({ roles: [] }),
  checkpointWhen: () => true,
});

function roleKey(url: string) {
  const parsed = new URL(url);
  const params = [...parsed.searchParams]
    .filter(([name]) => JOB_ID_PARAMS.test(name))
    .map(([name, value]) => `${name.toLowerCase()}=${value}`)
    .sort();
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${host}${path}${params.length ? `?${params.join("&")}` : ""}`;
}

const day = (timestamp: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: env.OWNER_TIMEZONE,
    day: "numeric",
    month: "short",
  }).format(timestamp);

function describeRoles(roles: readonly TrackedRole[]) {
  if (roles.length === 0) return "No tracked roles yet.";
  const sections = STATUSES.flatMap((status) => {
    const group = roles
      .filter((role) => role.status === status)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (group.length === 0) return [];
    if (status === "closed") {
      return [`${status} (${group.length}): not listed.`];
    }
    const lines = group.map(
      (role) =>
        `- ${role.company}, ${role.title} (${day(role.updatedAt)})${role.note ? `: ${role.note}` : ""}${status === "sent" ? ` ${role.url}` : ""}`,
    );
    return [`${status} (${group.length}):`, ...lines];
  });
  return [`${roles.length} tracked roles.`, ...sections].join("\n");
}

const text = (value: string) => [{ type: "text" as const, text: value }];

export const jobTrackerTool = defineTool({
  name: "job_tracker",
  deferred: true,
  description:
    "Record the roles in the owner's job search and list them by status. Record each role you send to the owner as sent, and record the owner's answer, such as applied, or dismissed with the reason. Before you suggest roles, list them and skip every role whose status is not sent.",
  parameters: Type.Object({
    record: Type.Optional(
      Type.Array(
        Type.Object({
          url: Type.String({ format: "uri" }),
          company: Type.String({ minLength: 1 }),
          title: Type.String({ minLength: 1 }),
          status: Type.Union(
            STATUSES.map((status) => Type.Literal(status)),
            {
              description:
                "sent: you sent it to the owner. dismissed: the owner does not want it. rejected: the employer turned the owner down. closed: the posting is gone.",
            },
          ),
          note: Type.Optional(
            Type.String({
              maxLength: 200,
              description:
                "Why, in a few words, such as the owner's reason to dismiss it.",
            }),
          ),
        }),
        { maxItems: 20, description: "Omit to only list the roles." },
      ),
    ),
  }),
  replay: "safe",
  async execute({ record = [] }, api, context) {
    const chat = String(api.conversationId);
    if (record.length === 0) {
      const doc = await api.snapshot(TrackedRoles, chat, context);
      return { output: text(describeRoles(doc?.roles ?? [])) };
    }
    const listing = await api.commit(async (tx) => {
      const doc = await tx.doc(TrackedRoles, chat, null);
      const now = Date.now();
      for (const update of record) {
        const key = roleKey(update.url);
        const existing = doc.roles.find((role) => role.key === key);
        if (!existing) {
          doc.roles.push({
            key,
            url: update.url,
            company: update.company,
            title: update.title,
            status: update.status,
            note: update.note ?? "",
            updatedAt: now,
          });
          continue;
        }
        existing.company = update.company;
        existing.title = update.title;
        if (update.note !== undefined) existing.note = update.note;
        if (update.status === "sent" && existing.status !== "sent") continue;
        existing.status = update.status;
        existing.updatedAt = now;
      }
      return describeRoles(doc.roles);
    }, context);
    return { output: text(listing) };
  },
});
