import { determineAgent } from '@vercel/detect-agent';
import { agents } from './agents.ts';
import { setDetectedAgent } from './telemetry.ts';
import type { AgentType } from './types.ts';

export type DetectedAgent =
  | { isAgent: true; agent: { name: string } }
  | { isAgent: false; agent?: undefined };

let cachedResult: DetectedAgent | null = null;

/**
 * Map from @vercel/detect-agent names to skills-cli AgentType identifiers.
 * Only includes agents that exist in both systems.
 */
const agentNameToType: Record<string, AgentType> = {
  cursor: 'cursor',
  'cursor-cli': 'cursor',
  claude: 'claude-code',
  cowork: 'claude-code',
  devin: 'universal', // Devin not in skills-cli agent list, use universal
  replit: 'replit',
  gemini: 'gemini-cli',
  codex: 'codex',
  antigravity: 'antigravity',
  'augment-cli': 'augment',
  doubao: 'doubao',
  opencode: 'opencode',
  'github-copilot': 'github-copilot',
  openclaw: 'openclaw',
  qoderwork: 'qoderwork',
  trae: 'trae',
  'trae-cn': 'trae-cn',
  workbuddy: 'workbuddy',
};

/**
 * Agents that are not covered by @vercel/detect-agent but expose a product
 * prefixed environment variable in the shells they spawn.
 */
const envPrefixAgents: Array<{ prefixes: string[]; agent: AgentType }> = [
  { prefixes: ['DOUBAO_'], agent: 'doubao' },
  { prefixes: ['WORKBUDDY_'], agent: 'workbuddy' },
  { prefixes: ['QODERWORK_'], agent: 'qoderwork' },
  { prefixes: ['OPENCLAW_', 'CLAWDBOT_', 'MOLTBOT_'], agent: 'openclaw' },
];

function detectFromEnvPrefixes(): DetectedAgent | null {
  const keys = Object.keys(process.env);
  for (const { prefixes, agent } of envPrefixAgents) {
    if (keys.some((key) => prefixes.some((prefix) => key.startsWith(prefix)))) {
      return { isAgent: true, agent: { name: agent } };
    }
  }
  return null;
}

/**
 * @vercel/detect-agent does not know about Trae, so detect it from the
 * environment variables the Trae client injects into its terminals.
 */
function detectTrae(): DetectedAgent | null {
  const brand = process.env.TRAE_BRAND_NAME ?? '';
  const isTrae =
    Boolean(process.env.TRAE_RUNTIME) ||
    brand.toLowerCase().includes('trae') ||
    process.env.TERM_PRODUCT === 'Trae';
  if (!isTrae) return null;

  const isCn =
    /trae\s*cn|cn\s*trae/i.test(brand) || process.env.TRAE_PRODUCT_REGION?.toLowerCase() === 'cn';
  return { isAgent: true, agent: { name: isCn ? 'trae-cn' : 'trae' } };
}

/**
 * Detect if the CLI is being run inside an AI agent environment.
 * Results are cached after the first call. Also updates telemetry with the agent name.
 */
export async function detectAgent(): Promise<DetectedAgent> {
  if (cachedResult) return cachedResult;
  cachedResult = detectTrae() ?? detectFromEnvPrefixes() ?? (await determineAgent());
  if (cachedResult.isAgent) {
    setDetectedAgent(cachedResult.agent.name);
  }
  return cachedResult;
}

/**
 * Returns true if the CLI is running inside a detected AI agent.
 * When true, the CLI should skip interactive prompts and use sensible defaults.
 */
export async function isRunningInAgent(): Promise<boolean> {
  const result = await detectAgent();
  return result.isAgent;
}

/**
 * Returns the name of the detected agent, or null if not running in an agent.
 */
export async function getAgentName(): Promise<string | null> {
  const result = await detectAgent();
  return result.isAgent ? result.agent.name : null;
}

/**
 * Maps a detected agent name to the corresponding skills-cli AgentType.
 * Returns null if the agent can't be mapped to a specific skills-cli agent.
 */
export function getAgentType(agentName: string): AgentType | null {
  const mapped = agentNameToType[agentName];
  if (mapped) return mapped;
  // AI_AGENT may already carry a skills-cli agent id (e.g. "qoder").
  return Object.hasOwn(agents, agentName) ? (agentName as AgentType) : null;
}
