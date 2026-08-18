import pc from 'picocolors';
import { AUDIT_URL, SEARCH_URL } from './config.ts';
import { track, slugifyTelemetryValue, type SecuritySignal } from './telemetry.ts';
import { parseSource, getOwnerRepo } from './source-parser.ts';

// ─── Audit command ───
// 单独查看某个技能的安全审计结果（风险等级 + risk_signals）。
// 用法与安装命令一致：
//   wittyhub audit <source> --skill <skill>
//   wittyhub audit https://github.com/huggingface/transformers --skill add-or-fix-type-checking
// 兼容旧用法（直接传 skill_id）：
//   wittyhub audit github/huggingface/transformers/add-or-fix-type-checking

/** 后端支持的 source_type 前缀，作为完整 skill_id 的识别依据 */
const SOURCE_TYPE_PREFIXES = ['github', 'gitcode', 'gitlab', 'gitee'];

export interface ParseAuditOptionsResult {
  source: string;
  skill: string;
  errors: string[];
}

export function parseAuditOptions(args: string[]): ParseAuditOptionsResult {
  let source = '';
  let skill = '';
  const errors: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-s' || arg === '--skill') {
      i++;
      skill = args[i]?.trim() ?? '';
    } else if (arg && !arg.startsWith('-')) {
      source = arg.trim();
    }
  }

  if (!source) {
    errors.push('Missing source or skill id');
  }
  return { source, skill, errors };
}

/**
 * 归一化技能标识：完整 skill_id（带 source_type 前缀）原样透传，
 * 否则默认补全 github/ 前缀，方便直接传 owner/repo/... 简写。
 */
export function normalizeSkillId(input: string): string {
  const trimmed = input.trim();
  const first = trimmed.split('/')[0];
  if (first && SOURCE_TYPE_PREFIXES.includes(first.toLowerCase())) {
    return trimmed;
  }
  return `github/${trimmed}`;
}

/**
 * 从 <source> + --skill <skill> 推导后端使用的 skill_id，
 * 与后端 build_skill_id_from_telemetry 的无 path 分支保持一致：
 *   {source_type}/{owner}/{repo}/{skill_path}
 */
export function buildSkillIdFromSource(source: string, skillName: string): string | null {
  const parsed = parseSource(source);
  if (!SOURCE_TYPE_PREFIXES.includes(parsed.type)) return null;

  const ownerRepo = getOwnerRepo(parsed);
  if (!ownerRepo) return null;

  const slugifiedOwnerRepo = ownerRepo.split('/').map(slugifyTelemetryValue).join('/');
  const skillPath = slugifyTelemetryValue(skillName);
  if (!skillPath) return null;
  return `${parsed.type}/${slugifiedOwnerRepo}/${skillPath}`;
}

/**
 * 通过后端搜索接口按 skill 名定位真实 skill_id。
 * 技能的 skill_path 是 SKILL.md 在仓库内的相对路径（如 .ai/skills/add-or-fix-type-checking），
 * 仅凭 skill 名无法直接推导，因此先搜索再按 source 前缀匹配。
 */
export async function resolveSkillIdBySourceAndName(
  source: string,
  skillName: string
): Promise<string | null> {
  let results: Array<{ skill_id: string; name: string; source_url: string }> = [];
  try {
    const params = new URLSearchParams({ q: skillName, limit: '10', mode: 'text' });
    const res = await fetch(`${SEARCH_URL}?${params.toString()}`);
    if (res.ok) {
      const data = (await res.json()) as {
        results?: Array<{ skill_id: string; name: string; source_url: string }>;
      };
      results = data.results ?? [];
    }
  } catch {
    return null;
  }

  const sourceLower = source.trim().toLowerCase();
  const matches = results.filter((skill) => {
    const url = (skill.source_url || '').toLowerCase();
    if (!url) return false;
    // source 是完整 URL：source_url 应以其为前缀
    if (url.startsWith(sourceLower)) return true;
    // source 是 owner/repo 简写：source_url 中应包含 /owner/repo/
    if (!sourceLower.includes('://') && sourceLower.split('/').length === 2) {
      return url.includes(`/${sourceLower}/`);
    }
    return false;
  });

  const exact = matches.find(
    (skill) => skill.name.toLowerCase() === skillName.trim().toLowerCase()
  );
  return exact ? exact.skill_id : matches.length > 0 ? matches[0]!.skill_id : null;
}

export interface SkillAuditDetail {
  risk_level: string;
  risk_score: number | null;
  risk_signals: SecuritySignal[];
  audited_at: string | null;
  audit_type?: string | null;
  details?: Record<string, unknown> | null;
}

export type AuditFetchResult =
  | { status: 'ok'; data: SkillAuditDetail }
  | { status: 'no_audit'; message: string }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

/** 按 skill_id 调用后端单技能审计接口，返回结构化结果或错误原因 */
export async function fetchSkillAudit(
  skillId: string,
  timeoutMs = 15000
): Promise<AuditFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = AUDIT_URL.replace(
      '{skill_id}',
      skillId.split('/').map(encodeURIComponent).join('/')
    );

    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch {
      return { status: 'error', message: `无法连接审计服务: ${AUDIT_URL}` };
    }

    if (response.status === 404) {
      return { status: 'not_found' };
    }

    if (!response.ok) {
      return { status: 'error', message: `审计服务返回 HTTP ${response.status}` };
    }

    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      return { status: 'error', message: '审计服务响应格式无效' };
    }

    if (data.error) {
      return { status: 'no_audit', message: String(data.error) };
    }

    return {
      status: 'ok',
      data: {
        risk_level: (data.risk_level as string) ?? 'unknown',
        risk_score: (data.risk_score as number) ?? null,
        risk_signals: (data.risk_signals as SecuritySignal[]) ?? [],
        audited_at: (data.audited_at as string) ?? null,
        audit_type: (data.audit_type as string) ?? null,
        details: (data.details as Record<string, unknown>) ?? null,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** 根据风险等级返回对应的着色函数：critical/high 红、medium 黄、low/safe 绿、未知灰 */
function riskColor(level: string): (text: string) => string {
  switch (level) {
    case 'critical':
    case 'high':
      return pc.red;
    case 'medium':
      return pc.yellow;
    case 'low':
    case 'safe':
      return pc.green;
    default:
      return pc.dim;
  }
}

const RISK_LABELS: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  safe: 'Safe',
};

/** 风险等级标签着色：critical 加粗红色，其余与 riskColor 同色 */
function riskLabel(level: string): string {
  const color = riskColor(level);
  const label = RISK_LABELS[level] || level || 'Unknown';
  return level === 'critical' ? color(pc.bold(label)) : color(label);
}

function severityColor(severity: string): string {
  const s = severity.toLowerCase();
  if (s === 'critical' || s === 'high') return pc.red(severity);
  if (s === 'medium') return pc.yellow(severity);
  if (s === 'low') return pc.green(severity);
  return pc.dim(severity);
}

/** 组装审计结果展示行：风险等级 + risk_signals */
export function buildAuditOutput(skillId: string, data: SkillAuditDetail): string[] {
  const lines: string[] = [];

  lines.push(`${pc.bold('Skill:')} ${pc.cyan(skillId)}`);
  const color = riskColor(data.risk_level);
  const score = data.risk_score != null ? color(`(score ${data.risk_score})`) : color('(score --)');
  lines.push(`${pc.bold('Risk:')} ${riskLabel(data.risk_level)} ${score}`);
  if (data.audited_at) {
    lines.push(`${pc.bold('Audited at:')} ${pc.dim(data.audited_at)}`);
  }

  lines.push('');
  if (data.risk_signals.length === 0) {
    lines.push(pc.green('No risk signals detected.'));
    return lines;
  }

  lines.push(pc.bold('Risk signals:'));
  for (const signal of data.risk_signals) {
    const severity = severityColor(signal.severity || 'unknown');
    lines.push(`  ${pc.bold(signal.name)}  ${pc.dim(`[${severity}]`)}`);
    if (signal.description) {
      lines.push(`    ${pc.dim(signal.description)}`);
    }
  }

  return lines;
}

export async function runAudit(args: string[]): Promise<void> {
  const { source, skill, errors } = parseAuditOptions(args);
  if (errors.length > 0) {
    for (const error of errors) console.error(pc.red(error));
    console.error('Usage: wittyhub audit <source> --skill <skill>');
    console.error('       wittyhub audit <skill_id>');
    return;
  }

  // 新格式：<source> + --skill <skill>；优先通过搜索接口定位真实 skill_id
  // （skill_path 是仓库内相对路径，仅凭名字无法推导），失败时回退到推导逻辑。
  // 兼容旧格式：无 --skill 时把第一个位置参数当作 skill_id。
  let skillId: string | null;
  if (skill) {
    skillId = await resolveSkillIdBySourceAndName(source, skill);
    if (!skillId) {
      const derived = buildSkillIdFromSource(source, skill);
      if (derived) {
        console.error(
          pc.yellow(`Could not locate skill via search; trying derived id: ${derived}`)
        );
        skillId = derived;
      }
    }
  } else {
    skillId = normalizeSkillId(source);
  }
  if (!skillId) {
    console.error(pc.red(`Unable to resolve skill id from source: ${source}`));
    console.error('Usage: wittyhub audit <source> --skill <skill>');
    return;
  }

  const result = await fetchSkillAudit(skillId);

  track({ event: 'audit', skillId, found: result.status === 'ok' ? '1' : '0' });

  switch (result.status) {
    case 'ok':
      for (const line of buildAuditOutput(skillId, result.data)) console.log(line);
      break;
    case 'no_audit':
      console.log(`${pc.yellow('No audit result yet.')} ${pc.dim(result.message)}`);
      break;
    case 'not_found':
      console.error(pc.red(`Skill not found: ${skillId}`));
      break;
    case 'error':
      console.error(pc.red(result.message));
      break;
  }
}
