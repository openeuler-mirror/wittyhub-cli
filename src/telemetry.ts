import { AUDIT_URL, TELEMETRY_URL } from './config.ts';

interface InstallTelemetryData {
  event: 'install';
  source: string;
  skills: string;
  agents: string;
  global?: '1';
  skillFiles?: string; // JSON stringified { skillName: relativePath }
  /**
   * Source type for different hosts:
   * - 'github': GitHub repository (default, uses raw.githubusercontent.com)
   * - 'raw': Direct URL to SKILL.md (generic raw URL)
   * - Provider IDs like 'mintlify', 'huggingface', etc.
   */
  sourceType?: string;
}

interface RemoveTelemetryData {
  event: 'remove';
  source?: string;
  skills: string;
  agents: string;
  global?: '1';
  sourceType?: string;
}

interface UpdateTelemetryData {
  event: 'update';
  scope?: string;
  skillCount: string;
  successCount: string;
  failCount: string;
}

interface FindTelemetryData {
  event: 'find';
  query: string;
  resultCount: string;
  interactive?: '1';
}

interface SyncTelemetryData {
  event: 'experimental_sync';
  skillCount: string;
  successCount: string;
  agents: string;
}

type TelemetryData =
  | InstallTelemetryData
  | RemoveTelemetryData
  | UpdateTelemetryData
  | FindTelemetryData
  | SyncTelemetryData;

let cliVersion: string | null = null;
let detectedAgentName: string | null = null;

/**
 * Set the detected AI agent name for telemetry tracking.
 * Called once during agent detection, then included in all telemetry events.
 */
export function setDetectedAgent(agentName: string | null): void {
  detectedAgentName = agentName;
}

function isCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.TRAVIS ||
    process.env.BUILDKITE ||
    process.env.JENKINS_URL ||
    process.env.TEAMCITY_VERSION
  );
}

function isEnabled(): boolean {
  return !process.env.DISABLE_TELEMETRY && !process.env.DO_NOT_TRACK;
}

export function setVersion(version: string): void {
  cliVersion = version;
}

// ─── Security audit data ───

export interface SecuritySignal {
  id: string;
  name: string;
  description?: string;
  severity: string;
}

export interface SkillAuditResult {
  risk_level: 'safe' | 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  risk_score: number | null;
  risk_signals: SecuritySignal[];
  audited_at: string | null;
}

/** Batch audit response, keyed by the requested skill name. */
export type AuditResponse = Record<string, SkillAuditResult>;

/**
 * Derive the same skill_id that the server uses for telemetry/audit lookups,
 * matching the Python ``build_skill_id_from_telemetry`` logic.
 */
function slugifyTelemetryValue(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (!lowered) return '';
  let normalized = lowered.replace(/[^a-z0-9._-]+/g, '-');
  normalized = normalized.replace(/-{2,}/g, '-');
  return normalized.replace(/^-|-$/g, '');
}

function buildSkillId(
  sourceType: string,
  ownerRepo: string,
  skillName: string,
  skillFiles?: Record<string, string>
): string | null {
  if (!['github', 'gitcode', 'gitlab', 'gitee'].includes(sourceType)) return null;
  if (!ownerRepo) return null;

  // Slugify owner/repo to match Python extract_owner_repo (slugify_identifier)
  const slugifiedOwnerRepo = ownerRepo.split('/').map(slugifyTelemetryValue).join('/');

  if (skillFiles) {
    const relativePath = skillFiles[skillName];
    if (relativePath) {
      const normalizedPath = relativePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      if (normalizedPath === 'SKILL.md') {
        const skillPath = slugifiedOwnerRepo.split('/').pop()!;
        return `${sourceType}/${slugifiedOwnerRepo}/${skillPath}`;
      }
      if (normalizedPath.endsWith('/SKILL.md')) {
        const skillPath = normalizedPath.slice(0, -'/SKILL.md'.length);
        return `${sourceType}/${slugifiedOwnerRepo}/${skillPath}`;
      }
    }
  }

  const skillPath = slugifyTelemetryValue(skillName);
  if (!skillPath) return null;
  return `${sourceType}/${slugifiedOwnerRepo}/${skillPath}`;
}

/**
 * Fetch security audit results for skills via the per-skill audit endpoint.
 * Returns null on any error or timeout — never blocks installation.
 */
export async function fetchAuditData(
  source: string,
  skillSlugs: string[],
  sourceType = 'github',
  skillFiles?: Record<string, string>,
  timeoutMs = 15000
): Promise<AuditResponse | null> {
  if (skillSlugs.length === 0) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const results: AuditResponse = {};
    const promises = skillSlugs.map(async (skillName) => {
      const skillId = buildSkillId(sourceType, source, skillName, skillFiles);
      if (!skillId) return;

      try {
        const response = await fetch(
          AUDIT_URL.replace('{skill_id}', skillId.split('/').map(encodeURIComponent).join('/')),
          { signal: controller.signal }
        );
        if (response.ok) {
          const data = (await response.json()) as Record<string, unknown>;
          if (!data.error) {
            results[skillName] = {
              risk_level: (data.risk_level as SkillAuditResult['risk_level']) ?? 'unknown',
              risk_score: (data.risk_score as number) ?? null,
              risk_signals: (data.risk_signals as SecuritySignal[]) ?? [],
              audited_at: (data.audited_at as string) ?? null,
            };
          }
        }
      } catch {
        // Individual skill fetch failed — skip
      }
    });

    await Promise.all(promises);
    return Object.keys(results).length > 0 ? results : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Pending telemetry promises — awaited before CLI exit so we don't lose data,
// but never block the main workflow.
const pendingTelemetry: Promise<void>[] = [];

export function track(data: TelemetryData): void {
  if (!isEnabled()) return;

  try {
    const params = new URLSearchParams();

    // Add version
    if (cliVersion) {
      params.set('v', cliVersion);
    }

    // Add CI flag if running in CI
    if (isCI()) {
      params.set('ci', '1');
    }

    // Add detected AI agent name
    if (detectedAgentName) {
      params.set('agent', detectedAgentName);
    }

    // Add event data
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }

    // Fire and forget during the workflow, but track the promise so
    // flushTelemetry() can await it before the process exits.
    const p = fetch(`${TELEMETRY_URL}?${params.toString()}`)
      .catch(() => {})
      .then(() => {});
    pendingTelemetry.push(p);
  } catch {
    // Silently fail - telemetry should never break the CLI
  }
}

/**
 * Wait for all in-flight telemetry requests to settle.
 * Called once at CLI exit so the process doesn't hang on open sockets
 * but also doesn't drop data by exiting too early.
 */
export async function flushTelemetry(timeoutMs = 5000): Promise<void> {
  if (pendingTelemetry.length === 0) return;
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([Promise.all(pendingTelemetry), timeout]);
}
