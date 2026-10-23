/** Copies Piton's chat history into .wrangler/history.sqlite. Usage: pnpm history [conversationId] [--last N] [--thinking] [--full] */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const DB_PATH = ".wrangler/history.sqlite";
const PAGE_SIZE = 50;
const CLIP_CHARS = 300;

type Row = (string | number | null)[];
type Block = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
};
type Message = {
  role: string;
  content: string | Block[];
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    last: { type: "string", default: "30" },
    thinking: { type: "boolean", default: false },
    full: { type: "boolean", default: false },
  },
});

function wrangler(...args: string[]) {
  return JSON.parse(
    execFileSync("pnpm", ["exec", "wrangler", ...args, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

const { token } = wrangler("auth", "token");
const accountId: string =
  process.env.CLOUDFLARE_ACCOUNT_ID ?? wrangler("whoami").accounts[0].id;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const json = (await response.json()) as {
    success: boolean;
    errors: unknown[];
    result: T;
  };
  if (!json.success) {
    throw new Error(`${path}: ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

const namespaces = await api<{ id: string; script: string; class: string }[]>(
  "/workers/durable_objects/namespaces",
);
const namespace = namespaces.find(
  (ns) => ns.script === "piton" && ns.class === "Piton",
);
if (!namespace)
  throw new Error("Durable Object namespace piton/Piton not found");

async function select(sql: string, params: (string | number)[] = []) {
  if (!/^\s*SELECT\b/i.test(sql) || sql.includes(";")) {
    throw new Error(`Refusing a statement that is not one SELECT: ${sql}`);
  }
  const result = await api<{
    error?: string;
    results: { rows: Row[] }[];
  }>(`/workers/durable_objects/namespaces/${namespace!.id}/query/v2`, {
    durable_object_name: "owner",
    jurisdiction: "none",
    queries: [{ sql, params }],
  });
  if (result.error) throw new Error(result.error);
  return result.results[0]!.rows;
}

const LATEST_BASE = (kind: string, fields: string) => `
  SELECT d.owner_id, ${fields}
  FROM documents d JOIN document_revisions r ON r.document_id = d.id
  WHERE d.kind = '"${kind}"' AND d.retired_at IS NULL AND r.kind = 'base'
    AND r.seq = (SELECT max(seq) FROM document_revisions WHERE document_id = d.id AND kind = 'base')`;

function blockText(block: Block) {
  switch (block.type) {
    case "text":
      return block.text ?? "";
    case "thinking":
      return values.thinking ? `[thinking] ${block.thinking ?? ""}` : "";
    case "toolCall":
      return `[call ${block.name}] ${JSON.stringify(block.arguments)}`;
    default:
      return `[${block.type}]`;
  }
}

function render(record: { kind: string; model?: Message[] }) {
  const message = record.model?.[0];
  if (!message) return { role: record.kind, at: null, text: "" };
  const body =
    typeof message.content === "string"
      ? message.content
      : message.content.map(blockText).filter(Boolean).join("\n");
  const text =
    message.role === "toolResult"
      ? `[${message.toolName}${message.isError ? " error" : ""}] ${body}`
      : body;
  return { role: message.role, at: message.timestamp ?? null, text };
}

async function pull() {
  mkdirSync(".wrangler", { recursive: true });
  rmSync(DB_PATH, { force: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, bot TEXT, assistant TEXT, job TEXT);
    CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER, kind TEXT, role TEXT, at INTEGER, text TEXT, record TEXT);
  `);
  const insertEntry = db.prepare(
    "INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (let after = 0; ; ) {
    const rows = await select(
      "SELECT id, conversation_id, record FROM entries WHERE id > ? ORDER BY id LIMIT ?",
      [after, PAGE_SIZE],
    );
    for (const [id, conversationId, raw] of rows) {
      const record = JSON.parse(String(raw));
      const { role, at, text } = render(record);
      insertEntry.run(id, conversationId, record.kind, role, at, text, raw);
    }
    if (rows.length < PAGE_SIZE) break;
    after = Number(rows.at(-1)![0]);
  }

  const bots = await select(
    LATEST_BASE("piton.chat-bot", "json_extract(r.content, '$.bot')"),
  );
  const assistants = new Map(
    (
      await select(
        LATEST_BASE(
          "piton.assistant",
          "d.key_value, json_extract(r.content, '$.name'), json_extract(r.content, '$.username'), json_extract(r.content, '$.job')",
        ),
      )
    ).map(([, key, name, username, job]) => [
      JSON.parse(String(key)),
      { name: name ?? username, job },
    ]),
  );
  const insertConversation = db.prepare(
    "INSERT INTO conversations VALUES (?, ?, ?, ?)",
  );
  for (const [conversationId, bot] of bots) {
    const assistant = assistants.get(bot);
    insertConversation.run(
      conversationId,
      bot,
      bot === "main" ? "Piton" : (assistant?.name ?? null),
      assistant?.job ?? null,
    );
  }
  return db;
}

const time = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kuala_Lumpur",
  dateStyle: "short",
  timeStyle: "short",
});
const formatTime = (at: unknown) =>
  typeof at === "number" ? time.format(new Date(at)) : "";
const clip = (text: string) =>
  values.full || text.length <= CLIP_CHARS
    ? text
    : `${text.slice(0, CLIP_CHARS)}…`;

const db = await pull();
const [conversationId] = positionals;

if (conversationId === undefined) {
  const rows = db
    .prepare(
      `SELECT e.conversation_id AS id, c.assistant, c.job, count(*) AS entries, max(e.at) AS last,
         (SELECT text FROM entries WHERE conversation_id = e.conversation_id AND role = 'user' ORDER BY id DESC LIMIT 1) AS lastUser
       FROM entries e LEFT JOIN conversations c ON c.id = e.conversation_id
       GROUP BY e.conversation_id ORDER BY last DESC`,
    )
    .all();
  for (const row of rows) {
    const name = row.assistant ?? "?";
    console.log(
      `${row.id}\t${name}\t${row.entries} entries\t${formatTime(row.last)}\t${clip(
        String(row.lastUser ?? ""),
      )
        .replace(/\s+/g, " ")
        .slice(0, 80)}`,
    );
  }
  console.log(`\nSaved to ${DB_PATH}. Run: pnpm history <id>`);
} else {
  const rows = db
    .prepare(
      `SELECT * FROM (SELECT id, role, at, text FROM entries WHERE conversation_id = ? AND role != 'system' ORDER BY id DESC LIMIT ?) ORDER BY id`,
    )
    .all(Number(conversationId), Number(values.last));
  for (const row of rows) {
    const text = String(row.text ?? "").trim();
    if (!text) continue;
    console.log(`--- #${row.id} ${row.role} ${formatTime(row.at)}`);
    console.log(clip(text));
  }
}
