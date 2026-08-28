import { slugifyTelemetryValue } from './telemetry.ts';
import { LIST_URL } from './config.ts';

// ─── 技能标识工具 ───
// skill_id 格式：{source_type}:{owner}/{repo}/{skill_path}
// 例如：github:vercel-labs/agent-skills/skills/deploy-to-vercel

/** 后端支持的 source_type 前缀，作为完整 skill_id 的识别依据 */
const SOURCE_TYPE_PREFIXES = ['github', 'gitcode', 'gitlab', 'gitee'];

/**
 * 归一化技能标识：完整 skill_id（带 source_type: 前缀）原样透传，
 * 否则默认补全 github: 前缀，方便直接传 owner/repo/... 简写。
 */
export function normalizeSkillId(input: string): string {
  const trimmed = input.trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx > 0) {
    const prefix = trimmed.slice(0, colonIdx).toLowerCase();
    if (SOURCE_TYPE_PREFIXES.includes(prefix)) {
      return trimmed;
    }
  }
  return `github:${trimmed}`;
}

/**
 * 从已分解的 sourceType、ownerRepo、skillName 构建 skill_id。
 * 支持 skillFiles（SKILL.md 相对路径），能精确还原后端 crawler 的 skill_id。
 * 与后端 build_skill_id_from_telemetry 逻辑保持一致。
 */
export function buildSkillId(
  sourceType: string,
  ownerRepo: string,
  skillName: string,
  skillFiles?: Record<string, string>
): string | null {
  if (!SOURCE_TYPE_PREFIXES.includes(sourceType)) return null;
  if (!ownerRepo) return null;

  const slugifiedOwnerRepo = ownerRepo.split('/').map(slugifyTelemetryValue).join('/');

  if (skillFiles) {
    const relativePath = skillFiles[skillName];
    if (relativePath) {
      const normalizedPath = relativePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      if (normalizedPath === 'SKILL.md') {
        const skillPath = slugifiedOwnerRepo.split('/').pop()!;
        return `${sourceType}:${slugifiedOwnerRepo}/${skillPath}`;
      }
      if (normalizedPath.endsWith('/SKILL.md')) {
        const skillPath = normalizedPath.slice(0, -'/SKILL.md'.length);
        return `${sourceType}:${slugifiedOwnerRepo}/${skillPath}`;
      }
    }
  }

  const skillPath = slugifyTelemetryValue(skillName);
  if (!skillPath) return null;
  return `${sourceType}:${slugifiedOwnerRepo}/${skillPath}`;
}

export interface SkillRef {
  skill_id: string;
  name: string;
  description?: string | null;
  source_url?: string | null;
}

/**
 * 判断输入是否为仓库级引用（source:owner/repo，无 skill_name）。
 * skill_id 格式为 source:owner/repo/skill_path，所以只有 1 个斜杠的就是仓库级。
 */
export function isRepoLevelRef(input: string): boolean {
  const trimmed = input.trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0) return false;
  const prefix = trimmed.slice(0, colonIdx).toLowerCase();
  if (!SOURCE_TYPE_PREFIXES.includes(prefix)) return false;
  const rest = trimmed.slice(colonIdx + 1);
  return rest.split('/').length === 2;
}

/** 域名 → source_type 映射 */
const HOST_TO_SOURCE_TYPE: Record<string, string> = {
  'github.com': 'github',
  'gitcode.com': 'gitcode',
  'gitlab.com': 'gitlab',
  'gitee.com': 'gitee',
};

/**
 * 把仓库 URL / owner-repo 简写解析为仓库级引用（source:owner/repo）。
 * 支持：
 *   - https://gitcode.com/owner/repo
 *   - http://github.com/owner/repo.git
 *   - git@gitcode.com:owner/repo
 *   - ssh://git@github.com/owner/repo
 * 无法识别（如本地路径、未知域名、多级路径）时返回 null。
 */
export function repoUrlToRef(input: string): string | null {
  const trimmed = input.trim().replace(/\.git$/, '');
  if (!trimmed) return null;

  // git@host:owner/repo → host/owner/repo
  const scpLike = trimmed.match(/^git@([^:]+):(.+)$/);
  if (scpLike) return refFromHostAndPath(scpLike[1]!, scpLike[2]!);

  // ssh://git@host/owner/repo → host/owner/repo
  const sshLike = trimmed.match(/^ssh:\/\/[^@]+@([^/]+)\/(.+)$/);
  if (sshLike) return refFromHostAndPath(sshLike[1]!, sshLike[2]!);

  // https://host/owner/repo（可带任意 scheme）
  const urlLike = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)\/(.+)$/i);
  if (urlLike) return refFromHostAndPath(urlLike[1]!, urlLike[2]!);

  return null;
}

function refFromHostAndPath(host: string, path: string): string | null {
  const sourceType = HOST_TO_SOURCE_TYPE[host.toLowerCase()];
  if (!sourceType) return null;
  const parts = path.replace(/\/+$/, '').split('/');
  if (parts.length !== 2 || parts.some((p) => !p)) return null;
  return `${sourceType}:${parts.join('/')}`;
}

/**
 * 查询 list API 获取仓库下所有技能。
 */
export async function listSkillsByRepo(sourceType: string, ownerRepo: string): Promise<SkillRef[]> {
  const slugifiedOwnerRepo = ownerRepo.split('/').map(slugifyTelemetryValue).join('/');
  const params = new URLSearchParams({
    source_type: sourceType,
    repo: slugifiedOwnerRepo,
    limit: '100',
  });
  const url = `${LIST_URL}?${params.toString()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const raw = (await res.json()) as Record<string, unknown>;
    const data = (raw.data || raw) as {
      skills?: Array<{
        skill_id: string;
        name: string;
        description?: string | null;
        source_url?: string | null;
      }>;
    };
    return (data.skills ?? [])
      .filter((skill) => skill && typeof skill.skill_id === 'string' && skill.skill_id)
      .map((skill) => ({
        skill_id: skill.skill_id,
        name: skill.name ?? '',
        description: skill.description ?? '',
        source_url: skill.source_url ?? '',
      }));
  } catch {
    return [];
  }
}
