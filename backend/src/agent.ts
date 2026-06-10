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
import { buildSystemPrompt } from "./system-prompt.js";

export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

export async function createVeloGuideSession() {
  const authStorage = AuthStorage.create("/tmp/velo-guide/auth.json");
  authStorage.setRuntimeApiKey("openrouter", process.env.OPENROUTER_API_KEY!);

  const modelRegistry = ModelRegistry.inMemory(authStorage);

  // Claude Haiku 4.5 is the default: ~2x Sonnet's generation throughput
  // (measured ~79 vs ~39 tok/s via OpenRouter) and reliable in multi-step tool
  // loops (unlike Gemini Flash, which intermittently ends a turn before writing
  // the itinerary), at ~3x lower cost than Sonnet. Latency here is dominated by
  // model generation across ~5-6 sequential turns, so throughput matters most.
  // Override via MODEL env for higher quality (anthropic/claude-sonnet-4.6) or
  // lowest cost (google/gemini-2.5-flash). All via the same OPENROUTER_API_KEY.
  // Cast: getModel's id param is a union of known literals; an env override is
  // an arbitrary string that OpenRouter resolves at runtime.
  const modelId = (process.env.MODEL ?? DEFAULT_MODEL) as Parameters<typeof getModel>[1];
  const model = getModel("openrouter", modelId);
  if (!model) throw new Error(`Model ${modelId} not found`);

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
    getSystemPrompt: () => buildSystemPrompt(),
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: "/tmp/velo-guide",
    model,
    thinkingLevel: "off",
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
