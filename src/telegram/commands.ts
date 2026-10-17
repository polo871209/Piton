import type { BotCommand } from "./api";

export const MASTER_COMMANDS: readonly BotCommand[] = [
  { command: "new", description: "Create an assistant: /new <name and job>" },
  { command: "reset", description: "Start a new session" },
  { command: "stop", description: "Stop the current answer" },
  { command: "login", description: "Sign in to Claude" },
  { command: "jobs", description: "List the recurring jobs of this chat" },
  { command: "help", description: "Show the commands" },
];

export const ASSISTANT_COMMANDS: readonly BotCommand[] = [
  { command: "reset", description: "Start a new session" },
  { command: "stop", description: "Stop the current answer" },
  { command: "jobs", description: "List the recurring jobs of this chat" },
  { command: "help", description: "Show the commands" },
];

const escapeHtml = (text: string) =>
  text.replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const helpText = (commands: readonly BotCommand[]) =>
  commands
    .map((c) => `- /${c.command}: ${escapeHtml(c.description)}`)
    .join("\n");

export function parseCommand(text: string) {
  const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match && { name: match[1]!, argument: match[2]?.trim() ?? "" };
}
