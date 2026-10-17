import { companyJobsTool } from "./company-jobs";
import { fetchPageTool } from "./fetch-page";
import { cancelJobTool, listJobsTool, scheduleJobTool } from "./schedule";
import { webSearchTool } from "./web-search";

export const TOOLS = [
  webSearchTool,
  fetchPageTool,
  companyJobsTool,
  scheduleJobTool,
  listJobsTool,
  cancelJobTool,
];
