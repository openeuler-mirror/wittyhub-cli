import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

const CLI_CONFIG_PATH = join(homedir(), '.config', 'wittyhub', 'cli.yaml');

export interface CliConfig {
  api_url?: string;
}

export function loadCliConfig(): CliConfig {
  if (!existsSync(CLI_CONFIG_PATH)) {
    return {};
  }

  try {
    const raw = readFileSync(CLI_CONFIG_PATH, 'utf-8');
    const parsed = parseYaml(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return parsed as CliConfig;
  } catch {
    return {};
  }
}

const cliConfig = loadCliConfig();

const DEFAULT_API_URL = 'https://skillhub.openeuler.org/api/v1';
// 后端技能接口，可通过 cli.yaml 的 api_url 或 SKILLS_API_URL 覆盖
export const API_URL =
  typeof cliConfig.api_url === 'string' && cliConfig.api_url.trim()
    ? cliConfig.api_url.trim().replace(/\/$/, '')
    : process.env.SKILLS_API_URL
      ? `${process.env.SKILLS_API_URL.replace(/\/$/, '')}/api/v1`
      : DEFAULT_API_URL;

export const SEARCH_URL = `${API_URL}/index/search`;
export const TELEMETRY_URL = `${API_URL}/skills/telemetry`;
export const AUDIT_URL = `${API_URL}/skills/{skill_id}/audit`;
export const GET_URL = `${API_URL}/skills/{skill_id}`;
export const LIST_URL = `${API_URL}/skills/`;
export const DOWNLOAD_URL = `${API_URL}/skills/{skill_id}/download`;
