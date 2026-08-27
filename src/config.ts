import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

const CLI_CONFIG_PATH = join(homedir(), '.config', 'wittyhub', 'cli.yaml');

export interface CliConfig {
  api_url?: string;
  telemetry_url?: string;
  audit_url?: string;
  search_url?: string;
  get_url?: string;
  list_url?: string;
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

const DEFAULT_API_URL = 'https://skillhub.openeuler.org/api/v1';
const DEFAULT_SEARCH_URL = 'https://skillhub.openeuler.org/api/v1/index/search';
const DEFAULT_TELEMETRY_URL = 'https://skillhub.openeuler.org/api/v1/skills/telemetry';
const DEFAULT_AUDIT_URL = 'https://skillhub.openeuler.org/api/v1/skills/{skill_id}/audit';
const DEFAULT_GET_URL = 'https://skillhub.openeuler.org/api/v1/skills/{skill_id}';
const DEFAULT_LIST_URL = 'https://skillhub.openeuler.org/api/v1/skills/';

const cliConfig = loadCliConfig();

// 后端技能接口，可通过 cli.yaml 的 api_url 或 SKILLS_API_URL 覆盖
export const API_URL =
  typeof cliConfig.api_url === 'string' && cliConfig.api_url.trim()
    ? cliConfig.api_url.trim()
    : process.env.SKILLS_API_URL
      ? `${process.env.SKILLS_API_URL.replace(/\/$/, '')}/api/v1`
      : DEFAULT_API_URL;

export const DOWNLOAD_URL = `${API_URL}/skills/{skill_id}/download`;

// 后端技能搜索接口，可通过 cli.yaml 的 search_url 或 SKILLS_API_URL 覆盖
export const SEARCH_URL =
  typeof cliConfig.search_url === 'string' && cliConfig.search_url.trim()
    ? cliConfig.search_url.trim()
    : process.env.SKILLS_API_URL
      ? `${process.env.SKILLS_API_URL.replace(/\/$/, '')}/api/v1/index/search`
      : DEFAULT_SEARCH_URL;

// 遥测接口，可通过 cli.yaml 的 telemetry_url 覆盖
export const TELEMETRY_URL =
  typeof cliConfig.telemetry_url === 'string' && cliConfig.telemetry_url.trim()
    ? cliConfig.telemetry_url.trim()
    : DEFAULT_TELEMETRY_URL;

// 审计接口，可通过 cli.yaml 的 audit_url 覆盖
export const AUDIT_URL =
  typeof cliConfig.audit_url === 'string' && cliConfig.audit_url.trim()
    ? cliConfig.audit_url.trim()
    : DEFAULT_AUDIT_URL;

// Skill 详情接口，可通过 cli.yaml 的 get_url 覆盖
export const GET_URL =
  typeof cliConfig.get_url === 'string' && cliConfig.get_url.trim()
    ? cliConfig.get_url.trim()
    : DEFAULT_GET_URL;

// Skill 列表接口（按仓库过滤定位技能），可通过 cli.yaml 的 list_url 覆盖；
// 未配置时从 get_url 推导（/api/v1/skills/{skill_id} → /api/v1/skills/）
export const LIST_URL =
  typeof cliConfig.list_url === 'string' && cliConfig.list_url.trim()
    ? cliConfig.list_url.trim()
    : GET_URL.replace(/\{skill_id\}[^/]*$/, '') || DEFAULT_LIST_URL;
