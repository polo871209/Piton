import type { CredentialStore } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { AgentChange } from "@earendil-works/pi-durable";
import { TOOLS } from "../tools";

// pi-ai loads OAuth flows through an import that bundlers cannot follow, so a Worker must register them statically.
registerBunOAuthFlows();

export const PROVIDER = "anthropic";

const LOGIN_CREDENTIAL_ONLY = {
  env: async () => undefined,
  fileExists: async () => false,
};

export const AGENT: AgentChange = {
  model: { provider: PROVIDER, modelId: "claude-sonnet-5-5" },
  thinkingLevel: "high",
  tools: TOOLS,
};

export function createPitonModels(credentials: CredentialStore) {
  const models = createModels({
    credentials,
    authContext: LOGIN_CREDENTIAL_ONLY,
  });
  models.setProvider(anthropicProvider());
  return models;
}
