import { companyJobsTool } from "./company-jobs";
import { cancelJobTool, listJobsTool, scheduleJobTool } from "./schedule";
import { webSearchTool } from "./web-search";

export const TOOLS = [
  webSearchTool,
  companyJobsTool,
  scheduleJobTool,
  listJobsTool,
  cancelJobTool,
];
