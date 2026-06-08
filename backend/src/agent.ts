import { getModel } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { veloGuideTools } from "./tools/index.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";

export async function createVeloGuideSession() {
  const authStorage = AuthStorage.create("/tmp/velo-guide/auth.json");
  authStorage.setRuntimeApiKey("openrouter", process.env.OPENROUTER_API_KEY!);

  const modelRegistry = ModelRegistry.inMemory(authStorage);

  const model = getModel("openrouter", "google/gemini-2.5-flash");
  if (!model) throw new Error("Model google/gemini-2.5-flash not found");

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });

  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => SYSTEM_PROMPT,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: "/tmp/velo-guide",
    model,
    thinkingLevel: "low",
    authStorage,
    modelRegistry,
    resourceLoader,
    noTools: "builtin",
    customTools: veloGuideTools,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  return session;
}
