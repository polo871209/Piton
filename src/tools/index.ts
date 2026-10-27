import { section } from "@earendil-works/pi-durable";
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";
import { companyJobsTool } from "./company-jobs";
import { fetchPageTool } from "./fetch-page";
import { jobTrackerTool } from "./job-tracker";
import { photoFrameTool } from "./photo-frame";
import { cancelJobTool, listJobsTool, scheduleJobTool } from "./schedule";
import { webSearchTool } from "./web-search";

export const TOOLS = [
  webSearchTool,
  fetchPageTool,
  scheduleJobTool,
  listJobsTool,
  cancelJobTool,
  createToolSearchTool(),
  companyJobsTool,
  jobTrackerTool,
  photoFrameTool,
];

const firstSentence = (text: string) => /^[^.]*\.?/.exec(text)?.[0] ?? text;

export const LOADABLE_TOOLS = section("loadable-tools", ({ agent }) =>
  agent.deferred.length === 0
    ? undefined
    : `Load one of these tools with tool_search when a request needs it. It stays loaded in this chat.
${agent.deferred.map((tool) => `- ${tool.name}: ${firstSentence(tool.description)}`).join("\n")}`,
);
