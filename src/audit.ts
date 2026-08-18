import pc from 'picocolors';
import { AUDIT_URL } from './config.ts';
import { track, type SecuritySignal } from './telemetry.ts';

// ─── Audit command ───
// 单独查看某个技能的安全审计结果（风险等级 + risk_signals）。

/** 后端支持的 source_type 前缀，作为完整 skill_id 的识别依据 */
const SOURCE_TYPE_PREFIXES = ['github', 'gitcode', 'gitlab', 'gitee'];

export interface ParseAuditOptionsResult {
  skillId: string;
  errors: string[];
}

export function parseAuditOptions(args: string[]): ParseAuditOptionsResult {
  const skillId = args[0]?.trim() ?? '';
  const errors: string[] = [];
  if (!skillId) {
    errors.push('Missing skill id');
  }
  return { skillId, errors };
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
  const { skillId, errors } = parseAuditOptions(args);
  if (errors.length > 0) {
    for (const error of errors) console.error(pc.red(error));
    console.error('Usage: wittyhub audit <skill_id>');
    return;
  }

  const normalized = normalizeSkillId(skillId);
  const result = await fetchSkillAudit(normalized);

  track({ event: 'audit', skillId: normalized, found: result.status === 'ok' ? '1' : '0' });

  switch (result.status) {
    case 'ok':
      for (const line of buildAuditOutput(normalized, result.data)) console.log(line);
      break;
    case 'no_audit':
      console.log(`${pc.yellow('No audit result yet.')} ${pc.dim(result.message)}`);
      break;
    case 'not_found':
      console.error(pc.red(`Skill not found: ${normalized}`));
      break;
    case 'error':
      console.error(pc.red(result.message));
      break;
  }
}
