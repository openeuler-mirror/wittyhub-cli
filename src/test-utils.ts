import { execSync } from 'child_process';
import { join } from 'path';
import { stripTerminalEscapes } from './sanitize.ts';

// const PROJECT_ROOT = join(import.meta.dirname, '..');
const CLI_PATH = join(import.meta.dirname, 'cli.ts');

/**
 * Environment variables that make the CLI detect it is running inside an AI
 * agent. Tests must not inherit them from the host, otherwise output differs
 * between a plain terminal and an agent terminal (banners, prompts, ...).
 */
const AGENT_ENV_KEYS = [
  'AI_AGENT',
  'ANTIGRAVITY_AGENT',
  'AUGMENT_AGENT',
  'CLAUDE_CODE',
  'CLAUDE_CODE_IS_COWORK',
  'CLAUDECODE',
  'CODEX_CI',
  'CODEX_SANDBOX',
  'CODEX_THREAD_ID',
  'COPILOT_ALLOW_ALL',
  'COPILOT_GITHUB_TOKEN',
  'COPILOT_MODEL',
  'CURSOR_AGENT',
  'CURSOR_EXTENSION_HOST_ROLE',
  'CURSOR_TRACE_ID',
  'GEMINI_CLI',
  'ICUBE_AI_AGENT_SHUTDOWN_TOKEN',
  'OPENCODE_CLIENT',
  'REPL_ID',
  'TERM_PRODUCT',
  'TRAE_BRAND_NAME',
  'TRAE_PRODUCT_REGION',
  'TRAE_RUNTIME',
];

/** Product-prefixed variables used to detect agents that set a whole family of keys. */
const AGENT_ENV_PREFIXES = [
  'CLAWDBOT_',
  'DOUBAO_',
  'MOLTBOT_',
  'OPENCLAW_',
  'QODERWORK_',
  'TRAE_',
  'WORKBUDDY_',
];

function buildEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of AGENT_ENV_KEYS) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (AGENT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

export function stripAnsi(str: string): string {
  return stripTerminalEscapes(str);
}

export function stripLogo(str: string): string {
  return str
    .split('\n')
    .filter((line) => !line.includes('███') && !line.includes('╔') && !line.includes('╚'))
    .join('\n')
    .replace(/^\n+/, '');
}

export function hasLogo(str: string): boolean {
  return str.includes('███') || str.includes('╔') || str.includes('╚');
}

export function runCli(
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
  timeout?: number
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const output = execSync(`node "${CLI_PATH}" ${args.join(' ')}`, {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildEnv(env),
      timeout: timeout ?? 30000,
    });
    return { stdout: stripAnsi(output), stderr: '', exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: stripAnsi(error.stdout || ''),
      stderr: stripAnsi(error.stderr || ''),
      exitCode: error.status || 1,
    };
  }
}

export function runCliOutput(args: string[], cwd?: string): string {
  const result = runCli(args, cwd);
  return result.stdout || result.stderr;
}

export function runCliWithInput(
  args: string[],
  input: string,
  cwd?: string
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const output = execSync(`node "${CLI_PATH}" ${args.join(' ')}`, {
      encoding: 'utf-8',
      cwd,
      input: input + '\n',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildEnv(),
    });
    return { stdout: stripAnsi(output), stderr: '', exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: stripAnsi(error.stdout || ''),
      stderr: stripAnsi(error.stderr || ''),
      exitCode: error.status || 1,
    };
  }
}
