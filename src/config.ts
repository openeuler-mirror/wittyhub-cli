import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

const CLI_CONFIG_PATH = join(homedir(), '.config', 'wittyhub', 'cli.yaml');

export interface CliConfig {
  telemetry_url?: string;
  audit_url?: string;
  search_url?: string;
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
