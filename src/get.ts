import pc from 'picocolors';
import { GET_URL } from './config.ts';
import { track } from './telemetry.ts';
import { resolveSkillId } from './skill-resolver.ts';

// ─── Get command ───
// 查看某个技能的详细信息（作者/分类/版本/描述/标签等）。
// 用法与安装命令一致：
//   wittyhub get <source> --skill <skill>
//   wittyhub get https://github.com/huggingface/transformers --skill add-or-fix-type-checking
// 兼容旧用法（直接传 skill_id）：
//   wittyhub get github/huggingface/transformers/.ai/skills/add-or-fix-type-checking

export interface ParseGetOptionsResult {
  source: string;
  skill: string;
  errors: string[];
}

export function parseGetOptions(args: string[]): ParseGetOptionsResult {
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

export interface SkillDetail {
  skill_id: string;
  name: string;
  description: string | null;
  version: string | null;
  commit_id: string | null;
  author: string | null;
  source: string;
  source_url: string;
  repo_url: string | null;
  category: string | null;
  tags: string[] | null;
  platform: string | null;
  metadata: Record<string, unknown> | null;
  risk_score: number | null;
  download_count: number;
  period_downloads: number | null;
  rating: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_indexed_at: string | null;
}

export type GetFetchResult =
  | { status: 'ok'; data: SkillDetail }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

/** 按 skill_id 调用后端单技能详情接口，返回结构化结果或错误原因 */
export async function fetchSkillDetail(
  skillId: string,
  timeoutMs = 15000
): Promise<GetFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = GET_URL.replace('{skill_id}', skillId.split('/').map(encodeURIComponent).join('/'));

    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch {
      return { status: 'error', message: `无法连接详情服务: ${GET_URL}` };
    }

    if (response.status === 404) {
      return { status: 'not_found' };
    }

    if (!response.ok) {
      return { status: 'error', message: `详情服务返回 HTTP ${response.status}` };
    }

    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      return { status: 'error', message: '详情服务响应格式无效' };
    }

    if (data.error) {
      return { status: 'error', message: String(data.error) };
    }

    const skillData = (data.data || data) as Record<string, unknown>;

    return {
      status: 'ok',
      data: {
        skill_id: (skillData.skill_id as string) ?? skillId,
        name: (skillData.name as string) ?? '',
        description: (skillData.description as string | null) ?? null,
        version: (skillData.version as string | null) ?? null,
        commit_id: (skillData.commit_id as string | null) ?? null,
        author: (skillData.author as string | null) ?? null,
        source: (skillData.source as string) ?? '',
        source_url: (skillData.source_url as string) ?? '',
        repo_url: (skillData.repo_url as string | null) ?? null,
        category: (skillData.category as string | null) ?? null,
        tags: Array.isArray(skillData.tags) ? (skillData.tags as string[]) : null,
        platform: (skillData.platform as string | null) ?? null,
        metadata: (skillData.metadata as Record<string, unknown>) ?? null,
        risk_score: (skillData.risk_score as number | null) ?? null,
        download_count: (skillData.download_count as number) ?? 0,
        period_downloads: (skillData.period_downloads as number | null) ?? null,
        rating: (skillData.rating as string | null) ?? null,
        created_at: (skillData.created_at as string | null) ?? null,
        updated_at: (skillData.updated_at as string | null) ?? null,
        last_indexed_at: (skillData.last_indexed_at as string | null) ?? null,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatInstalls(count: number): string {
  if (count === undefined || count === null || Number.isNaN(count)) return '0 installs';
  if (count <= 0) return '0 installs';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K installs`;
  return `${count} install${count === 1 ? '' : 's'}`;
}

/** 根据 risk_score 返回带颜色的风险等级标签（整串同色），未知时显示灰色 */
function formatRiskLevel(riskScore: number | null | undefined): string {
  if (riskScore === undefined || riskScore === null) return pc.dim('unknown risk');
  if (riskScore <= 20) return pc.green('safe risk');
  if (riskScore <= 50) return pc.green('low risk');
  if (riskScore <= 80) return pc.yellow('medium risk');
  return pc.red('high risk');
}

/** 组装 Skill 详情展示行：包含作者/分类/版本/描述/标签等关键信息 */
export function buildGetOutput(data: SkillDetail): string[] {
  const lines: string[] = [];

  lines.push(`${pc.bold('Skill:')} ${pc.cyan(data.skill_id)}`);
  if (data.name) lines.push(`${pc.bold('Name:')} ${data.name}`);
  if (data.description) lines.push(`${pc.bold('Description:')} ${data.description}`);
  if (data.author) lines.push(`${pc.bold('Author:')} ${data.author}`);
  if (data.category) lines.push(`${pc.bold('Category:')} ${data.category}`);
  if (data.version) lines.push(`${pc.bold('Version:')} ${data.version}`);
  if (data.tags && data.tags.length > 0) {
    lines.push(`${pc.bold('Tags:')} ${data.tags.join(', ')}`);
  }
  if (data.platform) lines.push(`${pc.bold('Platform:')} ${data.platform}`);
  if (data.source) lines.push(`${pc.bold('Source:')} ${data.source}`);
  if (data.source_url) lines.push(`${pc.bold('Source URL:')} ${pc.dim(data.source_url)}`);
  if (data.repo_url) lines.push(`${pc.bold('Repo URL:')} ${pc.dim(data.repo_url)}`);

  lines.push(`${pc.bold('Installs:')} ${pc.cyan(formatInstalls(data.download_count))}`);
  const riskLabel = formatRiskLevel(data.risk_score);
  const score =
    data.risk_score === undefined || data.risk_score === null
      ? ''
      : pc.dim(` (score ${data.risk_score})`);
  lines.push(`${pc.bold('Risk:')} ${riskLabel}${score}`);
  if (data.updated_at) lines.push(`${pc.bold('Updated at:')} ${pc.dim(data.updated_at)}`);

  return lines;
}

export async function runGet(args: string[]): Promise<void> {
  const { source, skill, errors } = parseGetOptions(args);
  if (errors.length > 0) {
    for (const error of errors) console.error(pc.red(error));
    console.error('Usage: wittyhub get <source> --skill <skill>');
    console.error('       wittyhub get <skill_id>');
    return;
  }

  // 新格式：<source> + --skill <skill>；优先通过列表接口按仓库精确匹配真实 skill_id，
  // 失败时回退推导逻辑。兼容旧格式：无 --skill 时把第一个位置参数当作 skill_id。
  const { skillId, derived } = await resolveSkillId(source, skill || undefined);
  if (!skillId) {
    console.error(pc.red(`Unable to resolve skill id from source: ${source}`));
    console.error('Usage: wittyhub get <source> --skill <skill>');
    return;
  }
  if (derived) {
    console.error(pc.yellow(`Could not locate skill in repo; trying derived id: ${skillId}`));
  }

  const result = await fetchSkillDetail(skillId);

  track({ event: 'get', skillId, found: result.status === 'ok' ? '1' : '0' });

  switch (result.status) {
    case 'ok':
      for (const line of buildGetOutput(result.data)) console.log(line);
      break;
    case 'not_found':
      console.error(pc.red(`Skill not found: ${skillId}`));
      break;
    case 'error':
      console.error(pc.red(result.message));
      break;
  }
}
