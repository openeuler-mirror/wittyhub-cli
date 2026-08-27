import { LIST_URL, SEARCH_URL } from './config.ts';
import { slugifyTelemetryValue } from './telemetry.ts';
import { parseSource, getOwnerRepo } from './source-parser.ts';

// ─── 共享技能解析逻辑 ───
// get / audit 命令共用：把 <source> --skill <skill> 稳定地解析成后端使用的 skill_id。
// 优先通过列表接口 GET /api/v1/skills/?source_type=&repo= 按仓库前缀精确匹配，
// 列表接口不可用或无结果时回退到搜索接口，最后回退到 skill_id 推导。

/** 后端支持的 source_type 前缀，作为完整 skill_id 的识别依据 */
const SOURCE_TYPE_PREFIXES = ['github', 'gitcode', 'gitlab', 'gitee'];

export interface SkillRef {
  skill_id: string;
  name: string;
  source_url: string;
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
 * 通过后端列表接口 GET /api/v1/skills/ 按仓库列出该仓库下的全部技能。
 * 使用 source_type + repo 两个参数，后端按 skill_id 前缀 {source_type}/{owner}/{repo}/
 * 精确过滤，从而稳定拿到目标仓库内的技能，不受搜索接口 top-N 限制。
 * 返回空数组表示列表接口不可用或仓库内没有技能。
 */
export async function listSkillsByRepo(source: string): Promise<SkillRef[]> {
  const parsed = parseSource(source);
  if (!SOURCE_TYPE_PREFIXES.includes(parsed.type)) return [];

  const ownerRepo = getOwnerRepo(parsed);
  if (!ownerRepo) return [];

  // 与后端 extract_owner_repo 的 slugify_identifier 保持一致，才能命中 skill_id 前缀
  const slugifiedOwnerRepo = ownerRepo.split('/').map(slugifyTelemetryValue).join('/');
  if (!slugifiedOwnerRepo || slugifiedOwnerRepo.split('/').length < 2) return [];

  const params = new URLSearchParams({
    source_type: parsed.type,
    repo: slugifiedOwnerRepo,
    limit: '100',
  });
  const url = `${LIST_URL}?${params.toString()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const raw = (await res.json()) as Record<string, unknown>;
    const data = (raw.data || raw) as {
      skills?: Array<{ skill_id: string; name: string; source_url?: string | null }>;
    };
    const result = (data.skills ?? [])
      .filter((skill) => skill && typeof skill.skill_id === 'string' && skill.skill_id)
      .map((skill) => ({
        skill_id: skill.skill_id,
        name: skill.name ?? '',
        source_url: skill.source_url ?? '',
      }));
    return result;
  } catch {
    return [];
  }
}

/**
 * 通过后端搜索接口按 skill 名定位真实 skill_id（回退方案）。
 * 技能的 skill_path 是 SKILL.md 在仓库内的相对路径（如 .ai/skills/add-or-fix-type-checking），
 * 仅凭 skill 名无法直接推导，因此先搜索再按 source 前缀匹配。
 */
async function resolveBySearch(source: string, skillName: string): Promise<string | null> {
  let results: SkillRef[] = [];
  try {
    const params = new URLSearchParams({ q: skillName, limit: '10', mode: 'text' });
    const res = await fetch(`${SEARCH_URL}?${params.toString()}`);
    if (res.ok) {
      const raw = (await res.json()) as Record<string, unknown>;
      const data = (raw.data || raw) as { results?: SkillRef[] };
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

/**
 * 按 <source> + --skill <skill> 定位真实 skill_id。
 * 优先通过列表接口按仓库精确匹配（稳定）；仓库列表非空但无匹配时直接返回 null
 * （不盲目回退搜索，避免通用技能名匹配到其他仓库）；列表接口不可用或为空时回退搜索。
 */
export async function resolveSkillIdBySourceAndName(
  source: string,
  skillName: string
): Promise<string | null> {
  const repoSkills = await listSkillsByRepo(source);

  if (repoSkills.length > 0) {
    const nameLower = skillName.trim().toLowerCase();
    const exact = repoSkills.find((skill) => skill.name.toLowerCase() === nameLower);
    if (exact) return exact.skill_id;

    // 按名字推导路径段匹配：skill_id 末尾段等于 slugify(skillName)
    const slug = slugifyTelemetryValue(skillName);
    if (slug) {
      const bySlug = repoSkills.find((skill) => {
        const last = skill.skill_id.split('/').pop() ?? '';
        return last.toLowerCase() === slug;
      });
      if (bySlug) return bySlug.skill_id;
    }
    return null;
  }

  return resolveBySearch(source, skillName);
}

export interface SkillIdResolution {
  skillId: string | null;
  /** 未能精确定位、回退到推导 skill_id（仅用于命令行提示） */
  derived: boolean;
}

/**
 * 统一的技能定位入口：
 * - 有 --skill 时优先按仓库精确匹配，失败回退推导；
 * - 无 --skill 时把 source 当作完整/简写 skill_id 归一化处理。
 */
export async function resolveSkillId(
  source: string,
  skillName?: string
): Promise<SkillIdResolution> {
  if (!skillName) {
    return { skillId: normalizeSkillId(source), derived: false };
  }

  const resolved = await resolveSkillIdBySourceAndName(source, skillName);
  if (resolved) return { skillId: resolved, derived: false };

  const derived = buildSkillIdFromSource(source, skillName);
  if (derived) return { skillId: derived, derived: true };

  return { skillId: null, derived: false };
}
