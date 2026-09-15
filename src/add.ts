import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { sep, join, dirname, resolve as resolvePath, isAbsolute } from 'node:path';
import { getOwnerRepo, parseOwnerRepo, isRepoPrivate } from './source-parser.ts';
import { DOWNLOAD_URL, SEARCH_URL } from './config.ts';
import {
  normalizeSkillId,
  isRepoLevelRef,
  listSkillsByRepo,
  repoUrlToRef,
  type SkillRef,
} from './skill-resolver.ts';
import { stripTerminalEscapes } from './sanitize.ts';
import { searchMultiselect } from './prompts/search-multiselect.ts';

// Helper to check if a value is a cancel symbol (works with both clack and our custom prompts)
const isCancelled = (value: unknown): value is symbol => typeof value === 'symbol';

/**
 * Check if a source identifier (owner/repo format) represents a private GitHub repo.
 * Returns true if private, false if public, null if unable to determine or not a GitHub repo.
 */
async function isSourcePrivate(source: string): Promise<boolean | null> {
  const ownerRepo = parseOwnerRepo(source);
  if (!ownerRepo) {
    // Not in owner/repo format, assume not private (could be other providers)
    return false;
  }
  return isRepoPrivate(ownerRepo.owner, ownerRepo.repo);
}

export function getLockSource(parsedUrl: string, normalizedSource: string | null): string | null {
  // Preserve SSH URLs in lock files instead of normalizing to owner/repo shorthand.
  // When normalizedSource is used, parseSource() later resolves it to HTTPS,
  // breaking restore for private repos that require SSH authentication.
  const isSSH = parsedUrl.startsWith('git@') || parsedUrl.startsWith('ssh://');
  return isSSH ? parsedUrl : normalizedSource;
}
import { cleanupTempDir, GitCloneError } from './git.ts';
import { discoverSkills, getSkillDisplayName, filterSkills } from './skills.ts';
import {
  installSkillForAgent,
  installBlobSkillForAgent,
  isSkillInstalled,
  getCanonicalPath,
  installWellKnownSkillForAgent,
  type InstallMode,
} from './installer.ts';
import {
  detectInstalledAgents,
  agents,
  getUniversalAgents,
  getVisibleUniversalAgents,
  getNonUniversalAgents,
  isUniversalAgent,
  getEveSubagents,
} from './agents.ts';
import {
  track,
  setVersion,
  fetchAuditBySkillId,
  type AuditResponse,
  type SkillAuditResult,
} from './telemetry.ts';
import { detectAgent, getAgentType } from './detect-agent.ts';
import { wellKnownProvider, type WellKnownSkill } from './providers/index.ts';
import {
  addSkillToLock,
  fetchSkillFolderHash,
  getGitHubToken,
  isPromptDismissed,
  dismissPrompt,
  getLastSelectedAgents,
  saveSelectedAgents,
} from './skill-lock.ts';
import { addSkillToLocalLock, computeSkillFolderHash } from './local-lock.ts';
import type { Skill, AgentType, ParsedSource } from './types.ts';
import {
  getSkillFolderHashFromTree,
  fetchRepoTree,
  type BlobSkill,
  type BlobInstallResult,
} from './blob.ts';
import packageJson from '../package.json' with { type: 'json' };
export function initTelemetry(version: string): void {
  setVersion(version);
}

const execFileAsync = promisify(execFile);

/**
 * Normalize a repo URL or owner/repo shorthand for matching against
 * `source_url` returned by the search API. Strips scheme, `.git` suffix,
 * trailing slashes, and lowercases. e.g.
 *   "https://github.com/foo/bar.git/" → "github.com/foo/bar"
 */
function normalizeRepoRef(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^(https?:\/\/|git:\/\/|ssh:\/\/)/, '');
  s = s.replace(/^git@([^:]+):/, '$1/');
  s = s.replace(/\.git$/, '');
  s = s.replace(/\/+$/, '');
  return s;
}

/** Is `source` a local filesystem path? (absolute, ./, ../, ~, or exists on disk) */
function looksLikeLocalPath(source: string): boolean {
  const s = source.trim();
  if (!s) return false;
  if (isAbsolute(s)) return true;
  if (s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..') return true;
  if (s.startsWith('~/')) return true;
  // Bare relative names: only when they exist as a directory (avoids clashing
  // with owner/repo shorthand).
  if (!s.includes(':') && !s.includes('/') && existsSync(resolvePath(process.cwd(), s))) {
    return statSync(resolvePath(process.cwd(), s)).isDirectory();
  }
  return false;
}

/** Expand ~ in a local path and resolve it against cwd. */
function expandLocalPath(source: string): string {
  const s = source.trim();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return resolvePath(process.cwd(), s);
}

function isDirectory(path: string): boolean {
  return statSync(path).isDirectory();
}

/**
 * Heuristic: does `source` look like a repo URL or owner/repo shorthand
 * (rather than a full skill_id)?
 *
 * - HTTP(S)/SSH/git URLs → repo URL
 * - `git@host:owner/repo` → repo URL
 * - owner/repo shorthand with exactly one slash → repo URL
 * - anything else (including full skill_ids like
 *   "github:owner/repo//foo") → treat as skill_id
 */
function looksLikeRepoSource(source: string): boolean {
  const s = source.trim();
  if (s.startsWith('http://') || s.startsWith('https://')) return true;
  if (s.startsWith('git@') || s.startsWith('ssh://') || s.startsWith('git://')) return true;
  // owner/repo shorthand: exactly one slash, no colon, no spaces
  const slashCount = (s.match(/\//g) || []).length;
  return slashCount <= 1 && !s.includes(':') && !/\s/.test(s);
}

interface SearchApiEnvelope {
  code?: number;
  msg?: string;
  data?: {
    results?: Array<{
      skill_id: string;
      name: string;
      source: string;
      source_url: string;
    }>;
    total?: number;
  };
  // Some deployments may skip the wrapper; keep the top-level fields as
  // fallback so this works with both shapes.
  results?: Array<{
    skill_id: string;
    name: string;
    source: string;
    source_url: string;
  }>;
  total?: number;
}

/**
 * Resolve `source` to skill_id(s) that the download API understands.
 *
 * Three input forms are supported:
 *   1. `source:owner/repo` (repo-level ref, no skill_name) → query list API
 *      for all skills under that repo. If `skillName` is provided, return
 *      only the matching skill_id; otherwise return all skill_ids.
 *   2. Full skill_id (e.g. "github:owner/repo/foo") → returned as-is.
 *   3. Repo URL / owner/repo shorthand AND `skillName` is provided → query
 *      the SEARCH_URL for that skill name, return the first match's skill_id.
 *
 * Throws on search failure or no match.
 */
async function resolveSkillId(
  source: string,
  skillName: string | undefined
): Promise<string | string[]> {
  // Form 1: repo-level ref (source:owner/repo) — list all skills under repo.
  // Always return all skill_ids; --skill filtering is handled downstream by
  // filterSkills() after discoverSkills() scans the downloaded archives.
  if (isRepoLevelRef(source)) {
    const [sourceType, ownerRepo] = source.split(':', 2);
    const skills = await listSkillsByRepo(sourceType!, ownerRepo!);
    if (skills.length === 0) {
      throw new Error(`仓库 "${source}" 下未找到已收录的技能。`);
    }
    return skills.map((s) => s.skill_id);
  }

  // Form 2: already a skill_id — normalize (e.g. add github: prefix for shorthand).
  if (!looksLikeRepoSource(source)) {
    return normalizeSkillId(source);
  }

  // Form 3: repo URL / shorthand — needs --skill.
  if (!skillName || !skillName.trim()) {
    throw new Error(
      `源 "${source}" 看起来是仓库地址，需要同时传入 --skill <skill_name> 才能定位具体技能。`
    );
  }

  const params = new URLSearchParams({
    q: skillName.trim(),
    limit: '20',
    mode: 'text',
    scope: 'summary',
  });
  const searchUrl = `${SEARCH_URL}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(searchUrl);
  } catch {
    throw new Error(`无法连接搜索服务: ${SEARCH_URL}`);
  }
  if (!res.ok) {
    throw new Error(`搜索服务返回 HTTP ${res.status}`);
  }

  const payload = (await res.json()) as SearchApiEnvelope;
  // API wraps responses in { code, msg, data }; fall back to the top-level
  // shape for deployments without the wrapper.
  const results = payload.data?.results ?? payload.results ?? [];
  if (results.length === 0) {
    throw new Error(`未找到名称匹配 "${skillName}" 的技能。`);
  }

  // Match results whose source_url lives inside the input repo. The API
  // returns source_url like
  //   "https://github.com/owner/repo/blob/main/<path>/SKILL.md"
  // so we do prefix matching after normalization, not exact equality.
  const wantedRef = normalizeRepoRef(source);
  const match =
    results.find((r) => {
      const ref = normalizeRepoRef(r.source_url);
      return ref === wantedRef || ref.startsWith(`${wantedRef}/`);
    }) ?? results[0];
  if (!match) {
    throw new Error(`未找到名称匹配 "${skillName}" 的技能。`);
  }
  return match.skill_id;
}

/**
 * Download a packaged skill archive from the wittyhub API and extract it
 * into a temporary directory. If `targetDir` is provided, extract into that
 * directory instead of creating a new one (used when downloading multiple
 * skills into the same temp dir).
 *
 * Returns the temp directory path containing the extracted skill files.
 * Throws on download or extraction failure so the caller can surface an error.
 */
async function downloadAndExtractSkill(skillId: string, targetDir?: string): Promise<string> {
  const downloadUrl = DOWNLOAD_URL.replace('{skill_id}', skillId);

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    // 透出后端错误 detail（如 409 时说明仓库本地克隆缺失等具体原因）
    const detail = await response
      .json()
      .then((data: { detail?: unknown }) =>
        typeof data?.detail === 'string' && data.detail ? `: ${data.detail}` : ''
      )
      .catch(() => '');
    throw new Error(`HTTP ${response.status} ${response.statusText}${detail}`);
  }

  const tempDir = targetDir ?? (await mkdtemp(join(tmpdir(), 'skills-')));
  const zipPath = join(tempDir, '.skill.zip');
  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(zipPath, buffer);

    try {
      await execFileAsync('unzip', ['-q', zipPath, '-d', tempDir]);
    } catch {
      throw new Error(
        "Failed to extract skill archive. Ensure the 'unzip' command is available on PATH."
      );
    }
  } finally {
    await rm(zipPath, { force: true });
  }

  return tempDir;
}

// ─── Security Advisory ───

function riskLabel(risk: string): string {
  switch (risk) {
    case 'critical':
      return pc.red(pc.bold('Critical'));
    case 'high':
      return pc.red('High');
    case 'medium':
      return pc.yellow('Med');
    case 'low':
      return pc.green('Low');
    case 'safe':
      return pc.green('Safe');
    default:
      return pc.dim('Unknown');
  }
}

/** Pad a string to a given visible width (ignoring ANSI escape codes). */
function padEnd(str: string, width: number): string {
  // Strip ANSI codes to measure visible length
  const visible = stripTerminalEscapes(str);
  const pad = Math.max(0, width - visible.length);
  return str + ' '.repeat(pad);
}

/**
 * Render a compact security table of wittyhub audit results.
 * Returns the lines to display, or empty array if no data.
 */
function buildSecurityLines(
  auditData: AuditResponse | null,
  skills: Array<{ slug: string; displayName: string }>
): string[] {
  if (!auditData) return [];

  const rows = skills.filter((s) => auditData[s.slug]);
  if (rows.length === 0) return [];

  // Compute column width for skill names
  const nameWidth = Math.min(Math.max(...rows.map((s) => s.displayName.length)), 36);

  // Header
  const lines: string[] = [];
  const header =
    padEnd('', nameWidth + 2) +
    padEnd(pc.dim('Risk'), 18) +
    padEnd(pc.dim('Score'), 8) +
    pc.dim('Signals');
  lines.push(header);

  // Rows
  for (const skill of rows) {
    const data = auditData[skill.slug]!;
    const name =
      skill.displayName.length > nameWidth
        ? skill.displayName.slice(0, nameWidth - 1) + '\u2026'
        : skill.displayName;

    const risk = riskLabel(data.risk_level);
    const score = data.risk_score != null ? pc.dim(String(data.risk_score)) : pc.dim('--');
    const signals =
      data.risk_signals.length > 0 ? pc.yellow(String(data.risk_signals.length)) : pc.dim('0');

    lines.push(
      padEnd(pc.cyan(name), nameWidth + 2) + padEnd(risk, 18) + padEnd(score, 8) + signals
    );
  }

  return lines;
}

/**
 * Skills flagged as high/critical risk, with their actual risk level.
 * Used to gate the install confirmation on risky skills.
 */
export interface HighRiskSkill {
  name: string;
  riskLevel: 'high' | 'critical';
}

export function getHighRiskSkills(
  auditData: AuditResponse | null,
  skills: Array<{ slug: string; displayName: string }>
): HighRiskSkill[] {
  if (!auditData) return [];
  return skills
    .filter((s) => {
      const data = auditData[s.slug];
      return data && (data.risk_level === 'high' || data.risk_level === 'critical');
    })
    .map((s) => ({
      name: s.displayName,
      riskLevel: auditData[s.slug]!.risk_level as 'high' | 'critical',
    }));
}

/**
 * Shortens a path for display: replaces homedir with ~ and cwd with .
 * Handles both Unix and Windows path separators.
 */
function shortenPath(fullPath: string, cwd: string): string {
  const home = homedir();
  // Ensure we match complete path segments by checking for separator after the prefix
  if (fullPath === home || fullPath.startsWith(home + sep)) {
    return '~' + fullPath.slice(home.length);
  }
  if (fullPath === cwd || fullPath.startsWith(cwd + sep)) {
    return '.' + fullPath.slice(cwd.length);
  }
  return fullPath;
}

function computeSingleFileSkillHash(contents: string): string {
  const hash = createHash('sha256');
  hash.update('SKILL.md');
  hash.update(contents);
  return hash.digest('hex');
}

/**
 * Formats a list of items, truncating if too many
 */
function formatList(items: string[], maxShow: number = 5): string {
  if (items.length <= maxShow) {
    return items.join(', ');
  }
  const shown = items.slice(0, maxShow);
  const remaining = items.length - maxShow;
  return `${shown.join(', ')} +${remaining} more`;
}

/**
 * Build the { skillName: repoRelativePath } map sent to both telemetry and
 * the batch audit endpoint, so both derive the same skill_id server-side.
 * Local-path skills (no repo temp dir) are skipped.
 */
function buildSkillFiles(
  selectedSkills: Skill[],
  tempDir: string | null,
  blobResult: BlobInstallResult | null
): Record<string, string> {
  const skillFiles: Record<string, string> = {};
  for (const skill of selectedSkills) {
    if (blobResult && 'repoPath' in skill) {
      // Blob-based: repoPath is already the repo-relative path (e.g., "skills/react/SKILL.md")
      skillFiles[skill.name] = (skill as BlobSkill).repoPath;
    } else if (tempDir && skill.path === tempDir) {
      // Skill is at root level of repo
      skillFiles[skill.name] = 'SKILL.md';
    } else if (tempDir && skill.path.startsWith(tempDir + sep)) {
      // Compute path relative to repo root (tempDir), not search path.
      // Use forward slashes for telemetry (URL-style paths)
      skillFiles[skill.name] =
        skill.path
          .slice(tempDir.length + 1)
          .split(sep)
          .join('/') + '/SKILL.md';
    }
    // Local path — no tempDir match, skip (same as telemetry)
  }
  return skillFiles;
}

/**
 * Splits agents into universal and non-universal (symlinked) groups.
 * Returns display names for each group.
 */
function splitAgentsByType(agentTypes: AgentType[]): {
  universal: string[];
  symlinked: string[];
} {
  const universal: string[] = [];
  const symlinked: string[] = [];

  for (const a of agentTypes) {
    if (isUniversalAgent(a)) {
      universal.push(agents[a].displayName);
    } else {
      symlinked.push(agents[a].displayName);
    }
  }

  return { universal, symlinked };
}

/**
 * Builds summary lines showing universal vs symlinked agents
 */
function buildAgentSummaryLines(targetAgents: AgentType[], installMode: InstallMode): string[] {
  const lines: string[] = [];
  const { universal, symlinked } = splitAgentsByType(targetAgents);

  if (installMode === 'symlink') {
    if (universal.length > 0) {
      lines.push(`  ${pc.green('universal:')} ${formatList(universal)}`);
    }
    if (symlinked.length > 0) {
      lines.push(`  ${pc.dim('symlink →')} ${formatList(symlinked)}`);
    }
  } else {
    // Copy mode - all agents get copies
    const allNames = targetAgents.map((a) => agents[a].displayName);
    lines.push(`  ${pc.dim('copy →')} ${formatList(allNames)}`);
  }

  return lines;
}

/**
 * A concrete install destination. For Eve, `subagent` optionally targets a
 * subagent's skills directory (`agent/subagents/<name>/skills`); when omitted
 * the skill installs to the root agent (`agent/skills`). Other agents never set
 * `subagent`.
 */
interface InstallTarget {
  agent: AgentType;
  subagent?: string;
}

/** Human-readable label for an install target, e.g. "Eve (research)". */
function targetDisplayName(target: InstallTarget): string {
  const base = agents[target.agent].displayName;
  return target.subagent ? `${base} (${target.subagent})` : base;
}

/** Stable key used to deduplicate / index per-target state. */
function targetKey(target: InstallTarget): string {
  return target.subagent ? `${target.agent}:${target.subagent}` : target.agent;
}

/**
 * Expand the selected agents into concrete install targets, fanning Eve out
 * across the chosen subagents (root and/or named subagents).
 */
function buildInstallTargets(
  targetAgents: AgentType[],
  eveSubagentTargets: Array<string | undefined>
): InstallTarget[] {
  const targets: InstallTarget[] = [];
  for (const agent of targetAgents) {
    if (agent === 'eve') {
      for (const subagent of eveSubagentTargets) {
        targets.push({ agent, subagent });
      }
    } else {
      targets.push({ agent });
    }
  }
  return targets;
}

/**
 * Builds summary lines showing universal vs symlinked agents and Eve subagents.
 */
function buildTargetSummaryLines(targets: InstallTarget[], installMode: InstallMode): string[] {
  const lines: string[] = [];
  const rootAgents = targets.filter((t) => !t.subagent).map((t) => t.agent);
  const subagentNames = targets.filter((t) => t.subagent).map(targetDisplayName);
  const { universal, symlinked } = splitAgentsByType(rootAgents);

  if (installMode === 'symlink') {
    if (universal.length > 0) {
      lines.push(`  ${pc.green('universal:')} ${formatList(universal)}`);
    }
    if (symlinked.length > 0) {
      lines.push(`  ${pc.dim('symlink →')} ${formatList(symlinked)}`);
    }
    if (subagentNames.length > 0) {
      lines.push(`  ${pc.dim('copy →')} ${formatList(subagentNames)}`);
    }
  } else {
    const allNames = targets.map(targetDisplayName);
    lines.push(`  ${pc.dim('copy →')} ${formatList(allNames)}`);
  }

  return lines;
}

/**
 * Ensures universal agents are always included in the target agents list.
 * Used when -y flag is passed or when auto-selecting agents.
 */
function ensureUniversalAgents(targetAgents: AgentType[]): AgentType[] {
  const universalAgents = getUniversalAgents();
  const result = [...targetAgents];

  for (const ua of universalAgents) {
    if (!result.includes(ua)) {
      result.push(ua);
    }
  }

  return result;
}

/**
 * Builds result lines from installation results, splitting by universal vs symlinked
 */
function buildResultLines(
  results: Array<{
    agent: string;
    symlinkFailed?: boolean;
    skipped?: boolean;
  }>,
  targetAgents: AgentType[]
): string[] {
  const lines: string[] = [];

  // Split target agents by type
  const { universal, symlinked: symlinkAgents } = splitAgentsByType(targetAgents);

  // For symlink results, also track which ones actually succeeded vs failed
  // Exclude skipped agents (those whose config dir doesn't exist in the project)
  const successfulSymlinks = results
    .filter((r) => !r.symlinkFailed && !r.skipped && !universal.includes(r.agent))
    .map((r) => r.agent);
  const failedSymlinks = results.filter((r) => r.symlinkFailed && !r.skipped).map((r) => r.agent);

  if (universal.length > 0) {
    lines.push(`  ${pc.green('universal:')} ${formatList(universal)}`);
  }
  if (successfulSymlinks.length > 0) {
    lines.push(`  ${pc.dim('symlinked:')} ${formatList(successfulSymlinks)}`);
  }
  if (failedSymlinks.length > 0) {
    lines.push(`  ${pc.yellow('copied:')} ${formatList(failedSymlinks)}`);
  }

  return lines;
}

function buildCopyResultLines(
  results: Array<{
    agent: string;
    path: string;
  }>,
  cwd: string
): string[] {
  const lines: string[] = [];
  const byPath = new Map<string, string[]>();

  for (const result of results) {
    const agentsForPath = byPath.get(result.path) || [];
    agentsForPath.push(result.agent);
    byPath.set(result.path, agentsForPath);
  }

  for (const [path, agentsForPath] of byPath) {
    lines.push(`  ${pc.dim('→')} ${shortenPath(path, cwd)}`);
    lines.push(`    ${pc.dim('copied to:')} ${formatList(agentsForPath)}`);
  }

  return lines;
}

/**
 * Let a pending prompt be aborted with the 'q' key (like ctrl+c, but friendlier).
 * Must only be attached to prompts without free-text input, where 'q' has no meaning.
 */
function withQuitOnQ<T>(promise: Promise<T>): Promise<T> {
  const handler = (_str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
    if (key?.name !== 'q' || key.ctrl || key.meta) return;
    process.stdin.removeListener('keypress', handler);
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    process.stdout.write('\n');
    p.cancel('Cancelled');
    process.exit(0);
  };
  process.stdin.on('keypress', handler);
  return promise.finally(() => {
    process.stdin.removeListener('keypress', handler);
  });
}

/**
 * Wrapper around p.multiselect that adds a hint for keyboard usage.
 * Accepts options with required labels (matching our usage pattern).
 */
function multiselect<Value>(opts: {
  message: string;
  options: Array<{ value: Value; label: string; hint?: string }>;
  initialValues?: Value[];
  required?: boolean;
}) {
  return withQuitOnQ(
    p.multiselect({
      ...opts,
      // Cast is safe: our options always have labels, which satisfies p.Option requirements
      options: opts.options as p.Option<Value>[],
      message: `${opts.message} ${pc.dim('(space to toggle, q to quit)')}`,
    }) as Promise<Value[] | symbol>
  );
}

/**
 * Prompts the user to select agents using interactive search.
 * Pre-selects the last used agents if available.
 * Saves the selection for future use.
 */
export async function promptForAgents(
  message: string,
  choices: Array<{ value: AgentType; label: string; hint?: string }>
): Promise<AgentType[] | symbol> {
  // Get last selected agents to pre-select
  let lastSelected: string[] | undefined;
  try {
    lastSelected = await getLastSelectedAgents();
  } catch {
    // Silently ignore errors reading lock file
  }

  const validAgents = choices.map((c) => c.value);

  // Default agents to pre-select when no valid history exists
  const defaultAgents: AgentType[] = ['claude-code', 'opencode', 'codex'];
  const defaultValues = defaultAgents.filter((a) => validAgents.includes(a));

  let initialValues: AgentType[] = [];

  if (lastSelected && lastSelected.length > 0) {
    // Filter stored agents against currently valid agents
    initialValues = lastSelected.filter((a) => validAgents.includes(a as AgentType)) as AgentType[];
  }

  // If no valid selection from history, use defaults
  if (initialValues.length === 0) {
    initialValues = defaultValues;
  }

  const selected = await searchMultiselect({
    message,
    items: choices,
    initialSelected: initialValues,
    required: true,
  });

  if (!isCancelled(selected)) {
    // Save selection for next time
    try {
      await saveSelectedAgents(selected as string[]);
    } catch {
      // Silently ignore errors writing lock file
    }
  }

  return selected as AgentType[] | symbol;
}

/**
 * Interactive agent selection using fuzzy search.
 * Shows universal agents as locked (always selected), and other agents as selectable.
 */
async function selectAgentsInteractive(options: {
  global?: boolean;
}): Promise<AgentType[] | symbol> {
  // Filter out agents that don't support global installation when --global is used
  const supportsGlobalFilter = (a: AgentType) => !options.global || agents[a].globalSkillsDir;

  const universalAgents = getUniversalAgents().filter(supportsGlobalFilter);
  const visibleUniversalAgents = getVisibleUniversalAgents().filter(supportsGlobalFilter);
  const otherAgents = getNonUniversalAgents().filter(
    (agent) => agent !== 'eve' && supportsGlobalFilter(agent)
  );

  // Universal agents shown as locked section
  const universalSection = {
    title: 'Universal (.agents/skills)',
    items: visibleUniversalAgents.map((a) => ({
      value: a,
      label: agents[a].displayName,
    })),
    hiddenCount: universalAgents.length - visibleUniversalAgents.length,
  };

  // Other agents are selectable with their skillsDir as hint
  const otherChoices = otherAgents.map((a) => ({
    value: a,
    label: agents[a].displayName,
    hint: options.global ? agents[a].globalSkillsDir! : agents[a].skillsDir,
  }));

  // Get last selected agents (filter to only non-universal ones for initial selection)
  let lastSelected: string[] | undefined;
  try {
    lastSelected = await getLastSelectedAgents();
  } catch {
    // Silently ignore errors
  }

  const initialSelected = lastSelected
    ? (lastSelected.filter(
        (a) => otherAgents.includes(a as AgentType) && !universalAgents.includes(a as AgentType)
      ) as AgentType[])
    : [];

  const selected = await searchMultiselect({
    message: 'Which agents do you want to install to?',
    items: otherChoices,
    initialSelected,
    lockedSection: universalSection,
  });

  if (!isCancelled(selected)) {
    // Save selection (all agents including universal)
    try {
      await saveSelectedAgents(selected as string[]);
    } catch {
      // Silently ignore errors
    }
  }

  return selected as AgentType[] | symbol;
}

const version = packageJson.version;
setVersion(version);

export interface AddOptions {
  global?: boolean;
  agent?: string[];
  yes?: boolean;
  skill?: string[];
  list?: boolean;
  all?: boolean;
  fullDepth?: boolean;
  copy?: boolean;
  dangerouslyAcceptOpenclawRisks?: boolean;
  /**
   * Eve subagent targets. Each value is a subagent name; `root` (or `.`)
   * selects the root agent. Implies installing for Eve.
   */
  subagent?: string[];
}

/**
 * Handle skills from a well-known endpoint (RFC 8615).
 * Discovers skills from /.well-known/agent-skills/index.json (preferred)
 * or /.well-known/skills/index.json (legacy fallback).
 */
async function handleWellKnownSkills(
  source: string,
  url: string,
  options: AddOptions,
  spinner: ReturnType<typeof p.spinner>
): Promise<void> {
  spinner.start('Discovering skills from well-known endpoint...');

  // Fetch all skills from the well-known endpoint
  const skills = await wellKnownProvider.fetchAllSkills(url);

  if (skills.length === 0) {
    spinner.stop(pc.red('No skills found'));
    p.outro(
      pc.red(
        'No skills found at this URL. Make sure the server has a /.well-known/agent-skills/index.json or /.well-known/skills/index.json file.'
      )
    );
    process.exit(1);
  }

  spinner.stop(`Found ${pc.green(skills.length)} skill${skills.length > 1 ? 's' : ''}`);

  // Log discovered skills
  for (const skill of skills) {
    p.log.info(`Skill: ${pc.cyan(skill.installName)}`);
    p.log.message(pc.dim(skill.description));
    if (skill.files.size > 1) {
      p.log.message(pc.dim(`  Files: ${Array.from(skill.files.keys()).join(', ')}`));
    }
  }

  if (options.list) {
    console.log();
    p.log.step(pc.bold('Available Skills'));
    for (const skill of skills) {
      p.log.message(`  ${pc.cyan(skill.installName)}`);
      p.log.message(`    ${pc.dim(skill.description)}`);
      if (skill.files.size > 1) {
        p.log.message(`    ${pc.dim(`Files: ${skill.files.size}`)}`);
      }
    }
    console.log();
    p.outro('Run without --list to install');
    process.exit(0);
  }

  // Filter skills if --skill option is provided
  let selectedSkills: WellKnownSkill[];

  if (options.skill?.includes('*')) {
    // --skill '*' selects all skills
    selectedSkills = skills;
    p.log.info(`Installing all ${skills.length} skills`);
  } else if (options.skill && options.skill.length > 0) {
    selectedSkills = skills.filter((s) =>
      options.skill!.some(
        (name) =>
          s.installName.toLowerCase() === name.toLowerCase() ||
          s.name.toLowerCase() === name.toLowerCase()
      )
    );

    if (selectedSkills.length === 0) {
      p.log.error(`No matching skills found for: ${options.skill.join(', ')}`);
      p.log.info('Available skills:');
      for (const s of skills) {
        p.log.message(`  - ${s.installName}`);
      }
      process.exit(1);
    }
  } else if (skills.length === 1) {
    selectedSkills = skills;
    const firstSkill = skills[0]!;
    p.log.info(`Skill: ${pc.cyan(firstSkill.installName)}`);
  } else if (options.yes) {
    selectedSkills = skills;
    p.log.info(`Installing all ${skills.length} skills`);
  } else {
    // Prompt user to select skills
    const skillChoices = skills.map((s) => ({
      value: s,
      label: s.installName,
      hint: s.description.length > 60 ? s.description.slice(0, 57) + '...' : s.description,
    }));

    const selected = await multiselect({
      message: 'Select skills to install',
      options: skillChoices,
      required: true,
    });

    if (p.isCancel(selected)) {
      p.cancel('Installation cancelled');
      process.exit(0);
    }

    selectedSkills = selected as WellKnownSkill[];
  }

  // Detect agents
  let targetAgents: AgentType[];
  const validAgents = Object.keys(agents);

  if (options.agent?.includes('*')) {
    // --agent '*' selects all agents
    targetAgents = validAgents as AgentType[];
    p.log.info(`Installing to all ${targetAgents.length} agents`);
  } else if (options.agent && options.agent.length > 0) {
    const invalidAgents = options.agent.filter((a) => !validAgents.includes(a));

    if (invalidAgents.length > 0) {
      p.log.error(`Invalid agents: ${invalidAgents.join(', ')}`);
      p.log.info(`Valid agents: ${validAgents.join(', ')}`);
      process.exit(1);
    }

    targetAgents = options.agent as AgentType[];
  } else {
    spinner.start('Loading agents...');
    const installedAgents = await detectInstalledAgents();
    const totalAgents = Object.keys(agents).length;
    spinner.stop(`${totalAgents} agents`);

    if (installedAgents.length === 0) {
      if (options.yes) {
        targetAgents = validAgents as AgentType[];
        p.log.info('Installing to all agents');
      } else {
        p.log.info('Select agents to install skills to');

        const allAgentChoices = Object.entries(agents).map(([key, config]) => ({
          value: key as AgentType,
          label: config.displayName,
        }));

        // Use helper to prompt with search
        const selected = await promptForAgents(
          'Which agents do you want to install to?',
          allAgentChoices
        );

        if (p.isCancel(selected)) {
          p.cancel('Installation cancelled');
          process.exit(0);
        }

        targetAgents = selected as AgentType[];
      }
    } else if (installedAgents.length === 1 || options.yes) {
      // Auto-select detected agents + ensure universal agents are included
      targetAgents = ensureUniversalAgents(installedAgents);
      if (installedAgents.length === 1) {
        const firstAgent = installedAgents[0]!;
        p.log.info(`Installing to: ${pc.cyan(agents[firstAgent].displayName)}`);
      } else {
        p.log.info(
          `Installing to: ${installedAgents.map((a) => pc.cyan(agents[a].displayName)).join(', ')}`
        );
      }
    } else {
      const selected = await selectAgentsInteractive({ global: options.global });

      if (p.isCancel(selected)) {
        p.cancel('Installation cancelled');
        process.exit(0);
      }

      targetAgents = selected as AgentType[];
    }
  }

  let installGlobally = options.global ?? false;

  // Check if any selected agents support global installation
  const supportsGlobal = targetAgents.some((a) => agents[a].globalSkillsDir !== undefined);

  if (options.global === undefined && !options.yes && supportsGlobal) {
    const scope = await p.select({
      message: 'Installation scope',
      options: [
        {
          value: false,
          label: 'Project',
          hint: 'Install in current directory (committed with your project)',
        },
        {
          value: true,
          label: 'Global',
          hint: 'Install in home directory (available across all projects)',
        },
      ],
    });

    if (p.isCancel(scope)) {
      p.cancel('Installation cancelled');
      process.exit(0);
    }

    installGlobally = scope as boolean;
  }

  // Determine install mode (symlink vs copy)
  let installMode: InstallMode = options.copy ? 'copy' : 'symlink';

  // Only prompt for install mode when there are multiple unique target directories.
  // When all selected agents share the same skillsDir, symlink vs copy is meaningless.
  const uniqueDirs = new Set(targetAgents.map((a) => agents[a].skillsDir));

  if (!options.copy && !options.yes && uniqueDirs.size > 1) {
    const modeChoice = await p.select({
      message: 'Installation method',
      options: [
        {
          value: 'symlink',
          label: 'Symlink (Recommended)',
          hint: 'Single source of truth, easy updates',
        },
        { value: 'copy', label: 'Copy to all agents', hint: 'Independent copies for each agent' },
      ],
    });

    if (p.isCancel(modeChoice)) {
      p.cancel('Installation cancelled');
      process.exit(0);
    }

    installMode = modeChoice as InstallMode;
  } else if (uniqueDirs.size <= 1) {
    // Single target directory — default to copy (no symlink needed)
    installMode = 'copy';
  }

  const cwd = process.cwd();

  // Build installation summary
  const summaryLines: string[] = [];
  const agentNames = targetAgents.map((a) => agents[a].displayName);

  // Check if any skill will be overwritten (parallel)
  const overwriteChecks = await Promise.all(
    selectedSkills.flatMap((skill) =>
      targetAgents.map(async (agent) => ({
        skillName: skill.installName,
        agent,
        installed: await isSkillInstalled(skill.installName, agent, { global: installGlobally }),
      }))
    )
  );
  const overwriteStatus = new Map<string, Map<string, boolean>>();
  for (const { skillName, agent, installed } of overwriteChecks) {
    if (!overwriteStatus.has(skillName)) {
      overwriteStatus.set(skillName, new Map());
    }
    overwriteStatus.get(skillName)!.set(agent, installed);
  }

  for (const skill of selectedSkills) {
    if (summaryLines.length > 0) summaryLines.push('');

    const canonicalPath = getCanonicalPath(skill.installName, { global: installGlobally });
    const shortCanonical = shortenPath(canonicalPath, cwd);
    summaryLines.push(`${pc.cyan(shortCanonical)}`);
    summaryLines.push(...buildAgentSummaryLines(targetAgents, installMode));
    if (skill.files.size > 1) {
      summaryLines.push(`  ${pc.dim('files:')} ${skill.files.size}`);
    }

    const skillOverwrites = overwriteStatus.get(skill.installName);
    const overwriteAgents = targetAgents
      .filter((a) => skillOverwrites?.get(a))
      .map((a) => agents[a].displayName);

    if (overwriteAgents.length > 0) {
      summaryLines.push(`  ${pc.yellow('overwrites:')} ${formatList(overwriteAgents)}`);
    }
  }

  console.log();
  p.note(summaryLines.join('\n'), 'Installation Summary');

  if (!options.yes) {
    const confirmed = await p.confirm({ message: 'Proceed with installation?' });

    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Installation cancelled');
      process.exit(0);
    }
  }

  // Kick off privacy check early so it runs in parallel with installation
  const sourceIdentifier = wellKnownProvider.getSourceIdentifier(url);
  const wellKnownPrivacyPromise = isSourcePrivate(sourceIdentifier).catch(() => null);

  spinner.start('Installing skills...');

  const results: {
    skill: string;
    agent: string;
    success: boolean;
    path: string;
    canonicalPath?: string;
    mode: InstallMode;
    symlinkFailed?: boolean;
    error?: string;
  }[] = [];

  for (const skill of selectedSkills) {
    for (const agent of targetAgents) {
      const result = await installWellKnownSkillForAgent(skill, agent, {
        global: installGlobally,
        mode: installMode,
      });
      results.push({
        skill: skill.installName,
        agent: agents[agent].displayName,
        ...result,
      });
    }
  }

  spinner.stop('Installation complete');

  console.log();
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  // Build skillFiles map: { skillName: sourceUrl }
  const skillFiles: Record<string, string> = {};
  for (const skill of selectedSkills) {
    skillFiles[skill.installName] = skill.sourceUrl;
  }

  // Privacy promise was started before installation — should be resolved by now
  const isPrivate = await wellKnownPrivacyPromise;
  if (isPrivate !== true) {
    track({
      event: 'install',
      source: sourceIdentifier,
      skills: selectedSkills.map((s) => s.installName).join(','),
      agents: targetAgents.join(','),
      ...(installGlobally && { global: '1' }),
      skillFiles: JSON.stringify(skillFiles),
      sourceType: 'well-known',
    });
  }

  // Add to skill lock file for update tracking (only for global installs)
  if (successful.length > 0 && installGlobally) {
    const successfulSkillNames = new Set(successful.map((r) => r.skill));
    for (const skill of selectedSkills) {
      if (successfulSkillNames.has(skill.installName)) {
        try {
          await addSkillToLock(skill.installName, {
            source: sourceIdentifier,
            sourceType: 'well-known',
            sourceUrl: skill.sourceUrl,
            skillFolderHash: '', // Well-known skills don't have a folder hash
          });
        } catch {
          // Don't fail installation if lock file update fails
        }
      }
    }
  }

  // Add to local lock file for project-scoped installs
  if (successful.length > 0 && !installGlobally) {
    const successfulSkillNames = new Set(successful.map((r) => r.skill));
    for (const skill of selectedSkills) {
      if (successfulSkillNames.has(skill.installName)) {
        try {
          const matchingResult = successful.find((r) => r.skill === skill.installName);
          const installDir = matchingResult?.canonicalPath || matchingResult?.path;
          if (installDir) {
            const computedHash = await computeSkillFolderHash(installDir);
            await addSkillToLocalLock(
              skill.installName,
              {
                source: sourceIdentifier,
                sourceType: 'well-known',
                computedHash,
              },
              cwd
            );
          }
        } catch {
          // Don't fail installation if lock file update fails
        }
      }
    }
  }

  if (successful.length > 0) {
    const bySkill = new Map<string, typeof results>();
    for (const r of successful) {
      const skillResults = bySkill.get(r.skill) || [];
      skillResults.push(r);
      bySkill.set(r.skill, skillResults);
    }

    const skillCount = bySkill.size;
    const symlinkFailures = successful.filter((r) => r.mode === 'symlink' && r.symlinkFailed);
    const copiedAgents = symlinkFailures.map((r) => r.agent);
    const resultLines: string[] = [];

    for (const [skillName, skillResults] of bySkill) {
      const firstResult = skillResults[0]!;

      if (firstResult.mode === 'copy') {
        // Copy mode: group identical install paths to avoid repeated output
        resultLines.push(`${pc.green('✓')} ${skillName} ${pc.dim('(copied)')}`);
        resultLines.push(...buildCopyResultLines(skillResults, cwd));
      } else {
        // Symlink mode: show canonical path and universal/symlinked agents
        if (firstResult.canonicalPath) {
          const shortPath = shortenPath(firstResult.canonicalPath, cwd);
          resultLines.push(`${pc.green('✓')} ${shortPath}`);
        } else {
          resultLines.push(`${pc.green('✓')} ${skillName}`);
        }
        resultLines.push(...buildResultLines(skillResults, targetAgents));
      }
    }

    const title = pc.green(`Installed ${skillCount} skill${skillCount !== 1 ? 's' : ''}`);
    p.note(resultLines.join('\n'), title);

    // Show symlink failure warning (only for symlink mode)
    if (symlinkFailures.length > 0) {
      p.log.warn(pc.yellow(`Symlinks failed for: ${formatList(copiedAgents)}`));
      p.log.message(
        pc.dim(
          '  Files were copied instead. On Windows, enable Developer Mode for symlink support.'
        )
      );
    }
  }

  if (failed.length > 0) {
    console.log();
    p.log.error(pc.red(`Failed to install ${failed.length}`));
    for (const r of failed) {
      p.log.message(`  ${pc.red('✗')} ${r.skill} → ${r.agent}: ${pc.dim(r.error)}`);
    }
  }

  console.log();
  p.outro(
    pc.green('Done!') + pc.dim('  Review skills before use; they run with full agent permissions.')
  );

  // Prompt for find-skills after successful install
  await promptForFindSkills(options, targetAgents);
}

/**
 * Install skills discovered from a local directory. Mirrors the API path's
 * list/select/install flow but without download or audit steps.
 */
async function installLocalSkills(
  source: string,
  localDir: string,
  skills: Skill[],
  options: AddOptions,
  agentResult: Awaited<ReturnType<typeof detectAgent>>
): Promise<void> {
  const spinner = p.spinner();

  // --list: print discovered skills and exit.
  if (options.list) {
    console.log();
    p.log.step(pc.bold('Available Skills'));
    for (const skill of skills) {
      p.log.message(`  ${pc.cyan(getSkillDisplayName(skill))}`);
      p.log.message(`    ${pc.dim(skill.description)}`);
    }
    console.log();
    p.outro('Use --skill <name> to install specific skills');
    return;
  }

  // Select skills (--skill / '*' / single-skill auto / interactive).
  let selectedSkills: Skill[];
  if (options.skill?.includes('*')) {
    selectedSkills = skills;
    p.log.info(`Installing all ${skills.length} skills`);
  } else if (options.skill && options.skill.length > 0) {
    selectedSkills = filterSkills(skills, options.skill);
    if (selectedSkills.length === 0) {
      p.log.error(`No matching skills found for: ${options.skill.join(', ')}`);
      p.log.info('Available skills:');
      for (const s of skills) {
        p.log.message(`  - ${getSkillDisplayName(s)}`);
      }
      process.exit(1);
    }
    p.log.info(
      `Selected ${selectedSkills.length} skill${selectedSkills.length !== 1 ? 's' : ''}: ${selectedSkills.map((s) => pc.cyan(getSkillDisplayName(s))).join(', ')}`
    );
  } else if (skills.length === 1 || options.yes) {
    selectedSkills = skills;
    if (skills.length === 1) {
      p.log.info(`Skill: ${pc.cyan(getSkillDisplayName(skills[0]!))}`);
      p.log.message(pc.dim(skills[0]!.description));
    } else {
      p.log.info(`Installing all ${skills.length} skills`);
    }
  } else {
    const sorted = [...skills].sort((a, b) =>
      getSkillDisplayName(a).localeCompare(getSkillDisplayName(b))
    );
    const selected = await multiselect({
      message: 'Select skills to install',
      options: sorted.map((s) => ({
        value: s,
        label: getSkillDisplayName(s),
        hint: s.description.length > 60 ? s.description.slice(0, 57) + '...' : s.description,
      })),
      required: true,
    });
    if (p.isCancel(selected)) {
      p.cancel('Installation cancelled');
      process.exit(0);
    }
    selectedSkills = selected as Skill[];
  }

  // Resolve target agents (validating explicit --agent values).
  let targetAgents: AgentType[];
  const validAgents = Object.keys(agents);

  if (options.agent?.includes('*')) {
    targetAgents = validAgents as AgentType[];
    p.log.info(`Installing to all ${targetAgents.length} agents`);
  } else if (options.agent && options.agent.length > 0) {
    const invalidAgents = options.agent.filter((a) => !validAgents.includes(a));
    if (invalidAgents.length > 0) {
      p.log.error(`Invalid agents: ${invalidAgents.join(', ')}`);
      p.log.info(`Valid agents: ${validAgents.join(', ')}`);
      process.exit(1);
    }
    targetAgents = options.agent as AgentType[];
  } else {
    spinner.start('Loading agents...');
    const installedAgents = await detectInstalledAgents();
    const totalAgents = Object.keys(agents).length;
    spinner.stop(`${totalAgents} agents`);

    if (installedAgents.length === 0) {
      if (options.yes) {
        targetAgents = validAgents as AgentType[];
        p.log.info('Installing to all agents');
      } else {
        p.log.info('Select agents to install skills to');
        const allAgentChoices = Object.entries(agents)
          .filter(([key]) => key !== 'eve')
          .map(([key, config]) => ({ value: key as AgentType, label: config.displayName }));
        const selected = await promptForAgents(
          'Which agents do you want to install to?',
          allAgentChoices
        );
        if (p.isCancel(selected)) {
          p.cancel('Installation cancelled');
          process.exit(0);
        }
        targetAgents = selected as AgentType[];
      }
    } else {
      targetAgents = ensureUniversalAgents(installedAgents);
      p.log.info(
        `Installing to: ${installedAgents.map((a) => pc.cyan(agents[a].displayName)).join(', ')}`
      );
    }
  }

  const installTargets = buildInstallTargets(targetAgents, [undefined]);
  let installGlobally = options.global ?? false;

  if (options.global === undefined && !options.yes) {
    const scope = await p.select({
      message: 'Installation scope',
      options: [
        {
          value: false,
          label: 'Project',
          hint: 'Install in current directory (committed with your project)',
        },
        {
          value: true,
          label: 'Global',
          hint: 'Install in home directory (available across all projects)',
        },
      ],
    });
    if (p.isCancel(scope)) {
      p.cancel('Installation cancelled');
      process.exit(0);
    }
    installGlobally = scope as boolean;
  }

  if (!options.yes) {
    const confirmed = await p.confirm({
      message: 'Proceed with installation?',
      initialValue: true,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Installation cancelled');
      process.exit(0);
    }
  }

  spinner.start('Installing skills...');
  const results: {
    skill: string;
    agent: string;
    success: boolean;
    path: string;
    error?: string;
  }[] = [];

  for (const skill of selectedSkills) {
    for (const target of installTargets) {
      const result = await installSkillForAgent(skill, target.agent, {
        global: installGlobally,
        mode: 'copy',
        eveSubagent: target.subagent,
      });
      results.push({
        skill: getSkillDisplayName(skill),
        agent: targetDisplayName(target),
        ...result,
      });
    }
  }
  spinner.stop('Installation complete');

  console.log();
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (successful.length > 0) {
    const bySkill = new Map<string, typeof results>();
    for (const r of successful) {
      if (!bySkill.has(r.skill)) bySkill.set(r.skill, []);
      bySkill.get(r.skill)!.push(r);
    }
    const resultLines: string[] = [];
    for (const [skillName, skillResults] of bySkill) {
      resultLines.push(`${pc.green('✓')} ${skillName} ${pc.dim('(copied)')}`);
      resultLines.push(...buildCopyResultLines(skillResults, process.cwd()));
    }
    p.note(
      resultLines.join('\n'),
      pc.green(`Installed ${bySkill.size} skill${bySkill.size !== 1 ? 's' : ''}`)
    );
  }

  if (failed.length > 0) {
    console.log();
    p.log.error(pc.red(`Failed to install ${failed.length}`));
    for (const r of failed) {
      p.log.message(`  ${pc.red('✗')} ${r.skill} → ${r.agent}: ${pc.dim(r.error)}`);
    }
  }

  console.log();
  p.outro(
    pc.green('Done!') + pc.dim('  Review skills before use; they run with full agent permissions.')
  );

  // Record in local lock file for project-scoped installs.
  if (successful.length > 0 && !installGlobally) {
    for (const skill of selectedSkills) {
      try {
        const computedHash = await computeSkillFolderHash(skill.path);
        await addSkillToLocalLock(
          skill.name,
          {
            source: source,
            sourceType: 'local',
            computedHash,
          },
          process.cwd()
        );
      } catch {
        // Don't fail installation if lock file update fails
      }
    }
  }

  await promptForFindSkills(options, targetAgents);
}

export async function runAdd(args: string[], options: AddOptions = {}): Promise<void> {
  const source = args[0];
  let installTipShown = false;

  const showInstallTip = (): void => {
    if (installTipShown) return;
    p.log.message(
      pc.dim('Tip: use the --yes (-y) and --global (-g) flags to install without prompts.')
    );
    installTipShown = true;
  };

  if (!source) {
    console.log();
    console.log(
      pc.bgRed(pc.white(pc.bold(' ERROR '))) + ' ' + pc.red('Missing required argument: source')
    );
    console.log();
    console.log(pc.dim('  Usage:'));
    console.log(
      `    ${pc.cyan('npx wittyhub add')} ${pc.yellow('<source>')} ${pc.dim('[options]')}`
    );
    console.log();
    console.log(pc.dim('  Example:'));
    console.log(`    ${pc.cyan('npx wittyhub add')} ${pc.yellow('vercel-labs/agent-skills')}`);
    console.log();
    process.exit(1);
  }

  // --all implies --skill '*' and --agent '*' and -y
  if (options.all) {
    options.skill = ['*'];
    options.agent = ['*'];
    options.yes = true;
  }

  // Auto-enable non-interactive mode when running inside an AI agent
  const agentResult = await detectAgent();
  if (agentResult.isAgent) {
    options.yes = true;
    // Auto-select the detected agent + universal agents (unless user explicitly specified agents)
    if (!options.agent || options.agent.length === 0) {
      const mappedAgent = getAgentType(agentResult.agent.name);
      if (mappedAgent) {
        options.agent = ensureUniversalAgents([mappedAgent]);
      }
    }
  }

  console.log();
  if (!agentResult.isAgent) {
    p.intro(pc.bgCyan(pc.black(' skills ')));
  }

  if (agentResult.isAgent) {
    p.log.info(
      pc.bgCyan(pc.black(pc.bold(` ${agentResult.agent.name} `))) +
        ' ' +
        'Agent detected — installing non-interactively'
    );
  } else if (!process.stdin.isTTY) {
    showInstallTip();
  }

  let tempDir: string | null = null;

  // Block openclaw sources unless explicitly opted in (checked before any
  // network request or local scan).
  const sourceOwner = source.split('/')[0]?.toLowerCase();
  if (sourceOwner === 'openclaw' && !options.dangerouslyAcceptOpenclawRisks) {
    console.log();
    p.log.warn(pc.yellow(pc.bold('⚠ OpenClaw skills are unverified community submissions.')));
    p.log.message(
      pc.yellow(
        'This source contains user-submitted skills that have not been reviewed for safety or quality.'
      )
    );
    p.log.message(pc.yellow('Skills run with full agent permissions and could be malicious.'));
    console.log();
    p.log.message(
      `If you understand the risks, re-run with:\n\n  ${pc.cyan(`npx wittyhub add ${source} --dangerously-accept-openclaw-risks`)}\n`
    );
    p.outro(pc.red('Installation blocked'));
    process.exit(1);
  }

  try {
    const spinner = p.spinner();

    // Local path source: scan the directory directly, no API download.
    // (Absolute paths, './x', '../x', '~', or bare names that exist on disk.)
    if (looksLikeLocalPath(source)) {
      const expanded = expandLocalPath(source);
      if (!existsSync(expanded)) {
        p.outro(pc.red(`Local path does not exist: ${expanded}`));
        process.exit(1);
      }
      if (!isDirectory(expanded)) {
        p.outro(pc.red(`Local path is not a directory: ${expanded}`));
        process.exit(1);
      }

      const includeInternal = !!(options.skill && options.skill.length > 0);
      spinner.start('Discovering skills...');
      let skills: Skill[];
      try {
        skills = await discoverSkills(expanded, undefined, {
          includeInternal,
          fullDepth: options.fullDepth,
        });
      } finally {
        spinner.stop('Discovery complete');
      }

      if (skills.length === 0) {
        p.log.error(pc.red('No skills found'));
        p.outro(
          pc.red('No valid skills found. Skills require a SKILL.md with name and description.')
        );
        process.exit(1);
      }

      // Delegate the rest of the flow (list / select / install) to the shared helper.
      await installLocalSkills(source, expanded, skills, options, agentResult);
      return;
    }

    // Step 1+2 (replaced): resolve `source` to skill_id(s), then download
    // packaged archive(s) from the wittyhub API. The ZIP is extracted into a
    // temp dir and fed into the existing discoverSkills flow.
    //
    // Three input forms are supported:
    //   - repo-level ref: "source:owner/repo" → list all skills under repo
    //   - full skill_id, e.g. "github:owner/repo/foo"
    //   - repo URL + --skill <name>, e.g.
    //     `add https://github.com/owner/repo --skill foo`
    //     → here we query SEARCH_URL to look up the skill_id.
    const skillNameForLookup = options.skill?.[0];
    let skillIds: string[];

    // Normalize repo URLs (https://gitcode.com/owner/repo, git@…, ssh://…)
    // into repo-level refs (source:owner/repo) so they flow through the
    // same list-API path instead of the search API.
    const repoRef = isRepoLevelRef(source) ? source : repoUrlToRef(source);
    const repoLevel = repoRef !== null;

    // For repo-level refs, resolve via list API (no download) and let the
    // user pick skills *before* downloading anything. This avoids pulling
    // dozens of archives just to render a selection list.
    if (repoLevel) {
      const [sourceType, ownerRepo] = repoRef!.split(':', 2);
      spinner.start('查询仓库下的技能...');
      let repoSkills: SkillRef[];
      try {
        repoSkills = await listSkillsByRepo(sourceType!, ownerRepo!);
      } finally {
        spinner.stop('查询完成');
      }
      if (repoSkills.length === 0) {
        p.outro(pc.red(`仓库 "${source}" 下未找到已收录的技能。`));
        process.exit(1);
      }

      // --list: just print from API data, no download.
      if (options.list) {
        console.log();
        p.log.step(pc.bold('Available Skills'));
        const sorted = [...repoSkills].sort((a, b) => a.name.localeCompare(b.name));
        for (const skill of sorted) {
          p.log.message(`  ${pc.cyan(skill.name)}`);
          if (skill.description) {
            p.log.message(`    ${pc.dim(skill.description)}`);
          }
        }
        console.log();
        p.outro('Use --skill <name> to install specific skills');
        process.exit(0);
      }

      // --skill: filter by name, download only matched.
      if (options.skill && !options.skill.includes('*')) {
        const matched = repoSkills.filter((s) =>
          options.skill!.some((name) => s.name === name || s.skill_id.endsWith('/' + name))
        );
        if (matched.length === 0) {
          p.outro(pc.red(`未找到匹配 --skill 的技能: ${options.skill.join(', ')}`));
          process.exit(1);
        }
        skillIds = matched.map((s) => s.skill_id);
      } else if (options.skill?.includes('*') || options.all || options.yes) {
        // --skill '*' / --all / --yes: install everything.
        skillIds = repoSkills.map((s) => s.skill_id);
      } else {
        // Interactive: pick from API data, then download only selected.
        const sorted = [...repoSkills].sort((a, b) => a.name.localeCompare(b.name));
        const choices = sorted.map((s) => ({
          value: s.skill_id,
          label: s.name,
          hint:
            s.description && s.description.length > 60
              ? s.description.slice(0, 57) + '...'
              : (s.description ?? ''),
        }));
        const selected = await multiselect({
          message: 'Select skills to install',
          options: choices,
          required: true,
        });
        if (p.isCancel(selected)) {
          p.cancel('Installation cancelled');
          process.exit(0);
        }
        skillIds = selected as string[];
      }
    } else {
      // Non-repo-level: resolve as before.
      try {
        const result = await resolveSkillId(source, skillNameForLookup);
        skillIds = Array.isArray(result) ? result : [result];
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        p.outro(pc.red(message));
        process.exit(1);
      }
    }

    spinner.start(
      `Downloading ${skillIds.length > 1 ? `${skillIds.length} skills` : `skill ${pc.cyan(skillIds[0]!)}`} from API...`
    );
    try {
      tempDir = await mkdtemp(join(tmpdir(), 'skills-'));
      for (const id of skillIds) {
        await downloadAndExtractSkill(id, tempDir);
      }
    } catch (e) {
      spinner.stop(pc.red('Download failed'));
      const message = e instanceof Error ? e.message : String(e);
      p.outro(pc.red(`Failed to download skill: ${message}`));
      process.exit(1);
    }
    spinner.stop(`Skill archive downloaded from ${pc.cyan('API')}`);

    // Synthetic parsed source consumed by downstream telemetry/lock-file logic.
    // `skillId` is the API skill_id (not a git URL), so getOwnerRepo() returns
    // null — telemetry gating and lock-file writes are skipped for now.
    const parsed: ParsedSource = {
      type: 'git',
      url: skillIds[0]!,
    };
    const repoPrivacyPromise: Promise<boolean | null> = Promise.resolve(null);

    // Include internal skills when a specific skill is explicitly requested
    // (via --skill). The @skill source syntax is no longer parsed now that
    // `source` is forwarded verbatim as a skill_id.
    const includeInternal = !!(options.skill && options.skill.length > 0);

    let skills: Skill[];
    let blobResult: BlobInstallResult | null = null;

    spinner.start('Discovering skills...');
    skills = await discoverSkills(tempDir, undefined, {
      includeInternal,
      fullDepth: options.fullDepth,
    });

    if (skills.length === 0) {
      spinner.stop(pc.red('No skills found'));
      p.outro(
        pc.red('No valid skills found. Skills require a SKILL.md with name and description.')
      );
      await cleanup(tempDir);
      process.exit(1);
    }

    if (!blobResult) {
      spinner.stop(`Found ${pc.green(skills.length)} skill${skills.length > 1 ? 's' : ''}`);
    }

    if (options.list) {
      // For repo-level refs, --list was already handled above (no download).
      // For other sources, print discovered skills here.
      console.log();
      p.log.step(pc.bold('Available Skills'));

      // Group available skills by plugin for list output
      const groupedSkills: Record<string, Skill[]> = {};
      const ungroupedSkills: Skill[] = [];

      for (const skill of skills) {
        if (skill.pluginName) {
          const group = skill.pluginName;
          if (!groupedSkills[group]) groupedSkills[group] = [];
          groupedSkills[group].push(skill);
        } else {
          ungroupedSkills.push(skill);
        }
      }

      // Print groups
      const sortedGroups = Object.keys(groupedSkills).sort();
      for (const group of sortedGroups) {
        // Convert kebab-case to Title Case for display header
        const title = group
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');

        console.log(pc.bold(title));
        for (const skill of groupedSkills[group]!) {
          p.log.message(`  ${pc.cyan(getSkillDisplayName(skill))}`);
          p.log.message(`    ${pc.dim(skill.description)}`);
        }
        console.log();
      }

      // Print ungrouped
      if (ungroupedSkills.length > 0) {
        if (sortedGroups.length > 0) console.log(pc.bold('General'));
        for (const skill of ungroupedSkills) {
          p.log.message(`  ${pc.cyan(getSkillDisplayName(skill))}`);
          p.log.message(`    ${pc.dim(skill.description)}`);
        }
      }

      console.log();
      p.outro('Use --skill <name> to install specific skills');
      await cleanup(tempDir);
      process.exit(0);
    }

    let selectedSkills: Skill[];

    // For repo-level refs, selection happened before download — install all
    // discovered skills (only selected ones were downloaded).
    if (repoLevel) {
      selectedSkills = skills;
      if (skills.length === 1) {
        p.log.info(`Skill: ${pc.cyan(getSkillDisplayName(skills[0]!))}`);
        p.log.message(pc.dim(skills[0]!.description));
      } else {
        p.log.info(`Installing ${skills.length} skills`);
      }
    } else if (options.skill?.includes('*')) {
      // --skill '*' selects all skills
      selectedSkills = skills;
      p.log.info(`Installing all ${skills.length} skills`);
    } else if (options.skill && options.skill.length > 0) {
      selectedSkills = filterSkills(skills, options.skill);

      if (selectedSkills.length === 0) {
        p.log.error(`No matching skills found for: ${options.skill.join(', ')}`);
        p.log.info('Available skills:');
        for (const s of skills) {
          p.log.message(`  - ${getSkillDisplayName(s)}`);
        }
        await cleanup(tempDir);
        process.exit(1);
      }

      p.log.info(
        `Selected ${selectedSkills.length} skill${selectedSkills.length !== 1 ? 's' : ''}: ${selectedSkills.map((s) => pc.cyan(getSkillDisplayName(s))).join(', ')}`
      );
    } else if (skills.length === 1) {
      selectedSkills = skills;
      const firstSkill = skills[0]!;
      p.log.info(`Skill: ${pc.cyan(getSkillDisplayName(firstSkill))}`);
      p.log.message(pc.dim(firstSkill.description));
    } else if (options.yes) {
      selectedSkills = skills;
      p.log.info(`Installing all ${skills.length} skills`);
    } else {
      // Sort skills by plugin name first, then by skill name
      const sortedSkills = [...skills].sort((a, b) => {
        if (a.pluginName && !b.pluginName) return -1;
        if (!a.pluginName && b.pluginName) return 1;
        if (a.pluginName && b.pluginName && a.pluginName !== b.pluginName) {
          return a.pluginName.localeCompare(b.pluginName);
        }
        return getSkillDisplayName(a).localeCompare(getSkillDisplayName(b));
      });

      // Check if any skills have plugin grouping
      const hasGroups = sortedSkills.some((s) => s.pluginName);

      let selected: Skill[] | symbol;

      if (hasGroups) {
        // Build grouped options for groupMultiselect
        const kebabToTitle = (s: string) =>
          s
            .split('-')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');

        const grouped: Record<string, p.Option<Skill>[]> = {};
        for (const s of sortedSkills) {
          const groupName = s.pluginName ? kebabToTitle(s.pluginName) : 'Other';
          if (!grouped[groupName]) grouped[groupName] = [];
          grouped[groupName]!.push({
            value: s,
            label: getSkillDisplayName(s),
            hint: s.description.length > 60 ? s.description.slice(0, 57) + '...' : s.description,
          });
        }

        selected = await p.groupMultiselect({
          message: `Select skills to install ${pc.dim('(space to toggle)')}`,
          options: grouped,
          required: true,
        });
      } else {
        const skillChoices = sortedSkills.map((s) => ({
          value: s,
          label: getSkillDisplayName(s),
          hint: s.description.length > 60 ? s.description.slice(0, 57) + '...' : s.description,
        }));

        selected = await multiselect({
          message: 'Select skills to install',
          options: skillChoices,
          required: true,
        });
      }

      if (p.isCancel(selected)) {
        p.cancel('Installation cancelled');
        await cleanup(tempDir);
        process.exit(0);
      }

      selectedSkills = selected as Skill[];
    }

    // Request security audit for the resolved skill_id(s).
    const auditPromise =
      skillIds.length === 1
        ? fetchAuditBySkillId(skillIds[0]!)
        : Promise.all(skillIds.map((id) => fetchAuditBySkillId(id))).then((results) =>
            results.reduce<AuditResponse>((acc, r) => ({ ...acc, ...r }), {})
          );

    let targetAgents: AgentType[];
    const validAgents = Object.keys(agents);

    if (options.agent?.includes('*')) {
      // --agent '*' selects all agents
      targetAgents = validAgents as AgentType[];
      p.log.info(`Installing to all ${targetAgents.length} agents`);
    } else if (options.agent && options.agent.length > 0) {
      const invalidAgents = options.agent.filter((a) => !validAgents.includes(a));

      if (invalidAgents.length > 0) {
        p.log.error(`Invalid agents: ${invalidAgents.join(', ')}`);
        p.log.info(`Valid agents: ${validAgents.join(', ')}`);
        await cleanup(tempDir);
        process.exit(1);
      }

      targetAgents = options.agent as AgentType[];
    } else {
      spinner.start('Loading agents...');
      const installedAgents = await detectInstalledAgents();
      const totalAgents = Object.keys(agents).length;
      spinner.stop(`${totalAgents} agents`);

      if (installedAgents.includes('eve') && (options.yes || !agentResult.isAgent)) {
        const useEve = options.yes
          ? true
          : await p.confirm({
              message: 'Detected an Eve project. Install skills for Eve?',
              initialValue: true,
            });

        if (p.isCancel(useEve)) {
          p.cancel('Installation cancelled');
          await cleanup(tempDir);
          process.exit(0);
        }

        if (useEve) {
          targetAgents = ['eve'];
          p.log.info(`Installing to: ${pc.cyan(agents.eve.displayName)}`);
        } else {
          const selected = await selectAgentsInteractive({ global: options.global });

          if (p.isCancel(selected)) {
            p.cancel('Installation cancelled');
            await cleanup(tempDir);
            process.exit(0);
          }

          targetAgents = selected as AgentType[];
        }
      } else if (installedAgents.length === 0) {
        if (options.yes) {
          targetAgents = validAgents as AgentType[];
          p.log.info('Installing to all agents');
        } else {
          p.log.info('Select agents to install skills to');

          const allAgentChoices = Object.entries(agents)
            .filter(([key]) => key !== 'eve')
            .map(([key, config]) => ({
              value: key as AgentType,
              label: config.displayName,
            }));

          // Use helper to prompt with search
          const selected = await promptForAgents(
            'Which agents do you want to install to?',
            allAgentChoices
          );

          if (p.isCancel(selected)) {
            p.cancel('Installation cancelled');
            await cleanup(tempDir);
            process.exit(0);
          }

          targetAgents = selected as AgentType[];
        }
      } else if (installedAgents.length === 1 || options.yes) {
        // Auto-select detected agents + ensure universal agents are included
        targetAgents = ensureUniversalAgents(installedAgents);
        if (installedAgents.length === 1) {
          const firstAgent = installedAgents[0]!;
          p.log.info(`Installing to: ${pc.cyan(agents[firstAgent].displayName)}`);
        } else {
          p.log.info(
            `Installing to: ${installedAgents.map((a) => pc.cyan(agents[a].displayName)).join(', ')}`
          );
        }
      } else {
        const selected = await selectAgentsInteractive({ global: options.global });

        if (p.isCancel(selected)) {
          p.cancel('Installation cancelled');
          await cleanup(tempDir);
          process.exit(0);
        }

        targetAgents = selected as AgentType[];
      }
    }

    // An explicit --subagent flag implies the user wants to target Eve.
    if (options.subagent && options.subagent.length > 0 && !targetAgents.includes('eve')) {
      targetAgents = [...targetAgents, 'eve'];
    }

    // Eve supports subagents, each with their own skills directory at
    // agent/subagents/<name>/skills in addition to the root agent/skills.
    // When Eve is a target, choose which of those to install into.
    let eveSubagentTargets: Array<string | undefined> = [undefined];
    if (targetAgents.includes('eve')) {
      const availableSubagents = getEveSubagents(process.cwd());

      if (options.subagent && options.subagent.length > 0) {
        // Non-interactive: 'root' or '.' selects the root agent.
        eveSubagentTargets = options.subagent.map((s) =>
          s === 'root' || s === '.' ? undefined : s
        );
      } else if (availableSubagents.length > 0 && !options.yes) {
        const subagentChoices = [
          { value: '', label: 'Root agent', hint: 'agent/skills' },
          ...availableSubagents.map((name) => ({
            value: name,
            label: name,
            hint: `agent/subagents/${name}/skills`,
          })),
        ];

        const selectedSubagents = await p.multiselect({
          message: 'Where should Eve skills be installed?',
          options: subagentChoices,
          initialValues: [''],
          required: true,
        });

        if (p.isCancel(selectedSubagents)) {
          p.cancel('Installation cancelled');
          await cleanup(tempDir);
          process.exit(0);
        }

        eveSubagentTargets = (selectedSubagents as string[]).map((s) => (s === '' ? undefined : s));
      }
    }

    const installTargets = buildInstallTargets(targetAgents, eveSubagentTargets);

    let installGlobally = options.global ?? false;

    // Check if any selected agents support global installation
    const supportsGlobal = targetAgents.some((a) => agents[a].globalSkillsDir !== undefined);

    if (options.global === undefined && !options.yes && supportsGlobal) {
      const scope = await p.select({
        message: 'Installation scope',
        options: [
          {
            value: false,
            label: 'Project',
            hint: 'Install in current directory (committed with your project)',
          },
          {
            value: true,
            label: 'Global',
            hint: 'Install in home directory (available across all projects)',
          },
        ],
      });

      if (p.isCancel(scope)) {
        p.cancel('Installation cancelled');
        await cleanup(tempDir);
        process.exit(0);
      }

      installGlobally = scope as boolean;
    }

    // Determine install mode (symlink vs copy)
    let installMode: InstallMode = options.copy ? 'copy' : 'symlink';

    // Only prompt for install mode when there are multiple unique target directories.
    // When all selected targets share the same skillsDir, symlink vs copy is meaningless.
    // Eve writes skill files directly into each (sub)agent dir, so a symlink prompt is
    // never meaningful when every target is Eve.
    const allEve = installTargets.every((t) => t.agent === 'eve');
    const uniqueDirs = new Set(
      installTargets.map((t) =>
        t.subagent ? `eve:subagent:${t.subagent}` : agents[t.agent].skillsDir
      )
    );

    if (!options.copy && !options.yes && uniqueDirs.size > 1 && !allEve) {
      const modeChoice = await p.select({
        message: 'Installation method',
        options: [
          {
            value: 'symlink',
            label: 'Symlink (Recommended)',
            hint: 'Single source of truth, easy updates',
          },
          { value: 'copy', label: 'Copy to all agents', hint: 'Independent copies for each agent' },
        ],
      });

      if (p.isCancel(modeChoice)) {
        p.cancel('Installation cancelled');
        await cleanup(tempDir);
        process.exit(0);
      }

      installMode = modeChoice as InstallMode;
    } else if (uniqueDirs.size <= 1 || allEve) {
      // Single target directory (or all-Eve) — default to copy (no symlink needed)
      installMode = 'copy';
    }

    const cwd = process.cwd();

    // Build installation summary
    const summaryLines: string[] = [];

    // Check if any skill will be overwritten (parallel)
    const overwriteChecks = await Promise.all(
      selectedSkills.flatMap((skill) =>
        installTargets.map(async (target) => ({
          skillName: skill.name,
          target,
          installed: await isSkillInstalled(skill.name, target.agent, {
            global: installGlobally,
            eveSubagent: target.subagent,
          }),
        }))
      )
    );
    // Keyed by skill name → target key → installed?
    const overwriteStatus = new Map<string, Map<string, boolean>>();
    for (const { skillName, target, installed } of overwriteChecks) {
      if (!overwriteStatus.has(skillName)) {
        overwriteStatus.set(skillName, new Map());
      }
      overwriteStatus.get(skillName)!.set(targetKey(target), installed);
    }

    // Group selected skills for summary
    const groupedSummary: Record<string, Skill[]> = {};
    const ungroupedSummary: Skill[] = [];

    for (const skill of selectedSkills) {
      if (skill.pluginName) {
        const group = skill.pluginName;
        if (!groupedSummary[group]) groupedSummary[group] = [];
        groupedSummary[group].push(skill);
      } else {
        ungroupedSummary.push(skill);
      }
    }

    // Helper to print summary lines for a list of skills
    const printSkillSummary = (skills: Skill[]) => {
      for (const skill of skills) {
        if (summaryLines.length > 0) summaryLines.push('');

        const canonicalPath =
          installTargets.length === 1
            ? getCanonicalPath(skill.name, {
                global: installGlobally,
                agent: installTargets[0]!.agent,
                eveSubagent: installTargets[0]!.subagent,
              })
            : getCanonicalPath(skill.name, { global: installGlobally });
        const shortCanonical = shortenPath(canonicalPath, cwd);
        summaryLines.push(`${pc.cyan(shortCanonical)}`);
        summaryLines.push(...buildTargetSummaryLines(installTargets, installMode));

        const skillOverwrites = overwriteStatus.get(skill.name);
        const overwriteAgents = installTargets
          .filter((t) => skillOverwrites?.get(targetKey(t)))
          .map(targetDisplayName);

        if (overwriteAgents.length > 0) {
          summaryLines.push(`  ${pc.yellow('overwrites:')} ${formatList(overwriteAgents)}`);
        }
      }
    };

    // Build grouped summary
    const sortedGroups = Object.keys(groupedSummary).sort();

    for (const group of sortedGroups) {
      const title = group
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

      summaryLines.push('');
      summaryLines.push(pc.bold(title));
      printSkillSummary(groupedSummary[group]!);
    }

    if (ungroupedSummary.length > 0) {
      if (sortedGroups.length > 0) {
        summaryLines.push('');
        summaryLines.push(pc.bold('General'));
      }
      printSkillSummary(ungroupedSummary);
    }

    console.log();
    p.note(summaryLines.join('\n'), 'Installation Summary');

    // Await and display security audit results (started earlier in parallel)
    // Wrapped in try/catch so a failed audit fetch never blocks installation.
    const auditSkills = selectedSkills.map((s) => ({
      slug: getSkillDisplayName(s),
      displayName: getSkillDisplayName(s),
    }));
    let auditData: AuditResponse | null = null;
    try {
      auditData = await auditPromise;
      if (auditData) {
        const securityLines = buildSecurityLines(auditData, auditSkills);
        if (securityLines.length > 0) {
          p.note(securityLines.join('\n'), 'Security Risk Assessments');
        }
      }
    } catch {
      // Silently skip — security info is advisory only
    }

    // Gate install on the security audit: risky skills require explicit consent.
    const highRiskSkills = getHighRiskSkills(auditData, auditSkills);
    if (highRiskSkills.length > 0) {
      const list = highRiskSkills
        .map((s) => `${s.name} 经安全审计标记为 ${s.riskLevel} 风险`)
        .join('，');
      p.log.warn(`${pc.red(pc.bold('⚠ 高风险警告：'))} ${list}，请谨慎安装。`);
    }

    if (!options.yes) {
      const message =
        highRiskSkills.length > 0
          ? `检测到以下技能存在安全风险：${highRiskSkills
              .map((s) => `${s.name} (${s.riskLevel})`)
              .join(', ')}。仍要继续安装？`
          : 'Proceed with installation?';
      const confirmed = await p.confirm({
        message,
        initialValue: highRiskSkills.length === 0,
      });

      if (p.isCancel(confirmed) || !confirmed) {
        p.cancel('Installation cancelled');
        await cleanup(tempDir);
        process.exit(0);
      }
    }

    spinner.start('Installing skills...');

    const results: {
      skill: string;
      agent: string;
      success: boolean;
      path: string;
      canonicalPath?: string;
      mode: InstallMode;
      symlinkFailed?: boolean;
      error?: string;
      pluginName?: string;
    }[] = [];

    for (const skill of selectedSkills) {
      for (const target of installTargets) {
        const { agent, subagent } = target;
        let result;
        if (blobResult && 'files' in skill) {
          // Blob-based install: write files from snapshot
          const blobSkill = skill as BlobSkill;
          result = await installBlobSkillForAgent(
            { installName: blobSkill.name, files: blobSkill.files },
            agent,
            { global: installGlobally, mode: installMode, eveSubagent: subagent }
          );
        } else if (tempDir && skill.path === tempDir && skill.rawContent) {
          // Remote root-level SKILL.md: install the skill file, not the whole repository.
          result = await installBlobSkillForAgent(
            { installName: skill.name, files: [{ path: 'SKILL.md', contents: skill.rawContent }] },
            agent,
            { global: installGlobally, mode: installMode }
          );
        } else {
          // Disk-based install: copy from cloned/local directory
          result = await installSkillForAgent(skill, agent, {
            global: installGlobally,
            mode: installMode,
            eveSubagent: subagent,
          });
        }
        results.push({
          skill: getSkillDisplayName(skill),
          agent: targetDisplayName(target),
          pluginName: skill.pluginName,
          ...result,
        });
      }
    }

    spinner.stop('Installation complete');

    console.log();
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    // Track installation result
    // Build skillFiles map: { skillName: relative path to SKILL.md from repo root }
    const skillFiles = buildSkillFiles(selectedSkills, tempDir, blobResult);

    // Normalize source to owner/repo format for telemetry
    const normalizedSource = getOwnerRepo(parsed);

    const lockSource = getLockSource(parsed.url, normalizedSource);

    // Only track if we have a valid remote source and it's not a private repo.
    // repoPrivacyPromise was started early (right after parsing) so it has
    // already been running in parallel with the entire install — no stall here.
    if (normalizedSource) {
      const ownerRepo = parseOwnerRepo(normalizedSource);
      if (ownerRepo) {
        const isPrivate = await repoPrivacyPromise;
        // For GitHub repos: only send telemetry if confirmed public (isPrivate === false).
        // For sources without a privacy check, repoPrivacyPromise returns null,
        // so we always send telemetry.
        if (isPrivate === false || (isPrivate === null && parsed.type !== 'github')) {
          console.log(
            '[telemetry-debug-1]',
            JSON.stringify({
              isPrivate,
              parsedType: parsed.type,
              normalizedSource,
              sourceType: parsed.type,
              skillFiles: JSON.stringify(skillFiles),
            })
          );
          track({
            event: 'install',
            source: normalizedSource,
            skills: selectedSkills.map((s) => s.name).join(','),
            agents: targetAgents.join(','),
            ...(installGlobally && { global: '1' }),
            skillFiles: JSON.stringify(skillFiles),
            sourceType: parsed.type,
          });
        }
      } else {
        // If we can't parse owner/repo, still send telemetry (for non-GitHub sources)
        console.log(
          '[telemetry-debug-2]',
          JSON.stringify({
            parsedType: parsed.type,
            normalizedSource,
            sourceType: parsed.type,
            skillFiles: JSON.stringify(skillFiles),
          })
        );
        track({
          event: 'install',
          source: normalizedSource,
          skills: selectedSkills.map((s) => s.name).join(','),
          agents: targetAgents.join(','),
          ...(installGlobally && { global: '1' }),
          skillFiles: JSON.stringify(skillFiles),
          sourceType: parsed.type,
        });
      }
    }

    // Add to skill lock file for update tracking (only for global installs)
    if (successful.length > 0 && installGlobally && normalizedSource) {
      const successfulSkillNames = new Set(successful.map((r) => r.skill));

      // For GitHub clone installs, fetch the repo tree once and reuse it
      // for all skills — avoids N sequential API calls that take ~400ms each.
      let cachedTree: Awaited<ReturnType<typeof fetchRepoTree>> | undefined;
      if (parsed.type === 'github' && !blobResult) {
        cachedTree = await fetchRepoTree(normalizedSource, parsed.ref, getGitHubToken);
      }

      for (const skill of selectedSkills) {
        const skillDisplayName = getSkillDisplayName(skill);
        if (successfulSkillNames.has(skillDisplayName)) {
          try {
            let skillFolderHash = '';
            const skillPathValue = skillFiles[skill.name];

            if (blobResult && skillPathValue) {
              const hash = getSkillFolderHashFromTree(
                (blobResult as BlobInstallResult).tree,
                skillPathValue
              );
              if (hash) skillFolderHash = hash;
            } else if (parsed.type === 'github' && skillPathValue && cachedTree) {
              const hash = getSkillFolderHashFromTree(cachedTree, skillPathValue);
              if (hash) skillFolderHash = hash;
            } else if (skillPathValue && tempDir) {
              const skillDir = join(tempDir, dirname(skillPathValue));
              const hash = await computeSkillFolderHash(skillDir);
              if (hash) skillFolderHash = hash;
            }

            await addSkillToLock(skill.name, {
              source: lockSource || normalizedSource,
              sourceType: parsed.type,
              sourceUrl: parsed.url,
              ref: parsed.ref,
              skillPath: skillPathValue,
              skillFolderHash,
              pluginName: skill.pluginName,
            });
          } catch {
            // Don't fail installation if lock file update fails
          }
        }
      }
    }

    // Add to local lock file for project-scoped installs
    if (successful.length > 0 && !installGlobally) {
      const successfulSkillNames = new Set(successful.map((r) => r.skill));
      // Record Eve subagent placement (root = '') so `update` can restore it.
      // Only meaningful when Eve is among the targets and a non-root subagent
      // was selected; otherwise omit for a clean, minimal lock entry.
      const eveSubagents = targetAgents.includes('eve')
        ? eveSubagentTargets.map((s) => s ?? '')
        : undefined;
      const recordSubagents =
        eveSubagents && (eveSubagents.length > 1 || eveSubagents.some((s) => s !== ''));
      for (const skill of selectedSkills) {
        const skillDisplayName = getSkillDisplayName(skill);
        if (successfulSkillNames.has(skillDisplayName)) {
          try {
            // For blob skills, use the snapshot hash; for disk skills, compute from files
            const computedHash =
              blobResult && 'snapshotHash' in skill
                ? (skill as BlobSkill).snapshotHash
                : tempDir && skill.path === tempDir && skill.rawContent
                  ? computeSingleFileSkillHash(skill.rawContent)
                  : await computeSkillFolderHash(skill.path);
            const skillPathValue = skillFiles[skill.name];
            await addSkillToLocalLock(
              skill.name,
              {
                source: lockSource || parsed.url,
                ref: parsed.ref,
                sourceType: parsed.type,
                ...(skillPathValue && { skillPath: skillPathValue }),
                computedHash,
                ...(recordSubagents && { subagents: eveSubagents }),
              },
              cwd
            );
          } catch {
            // Don't fail installation if lock file update fails
          }
        }
      }
    }

    if (successful.length > 0) {
      const bySkill = new Map<string, typeof results>();

      // Group results by plugin name
      const groupedResults: Record<string, typeof results> = {};
      const ungroupedResults: typeof results = [];

      for (const r of successful) {
        const skillResults = bySkill.get(r.skill) || [];
        skillResults.push(r);
        bySkill.set(r.skill, skillResults);

        // We only need to group once per skill (take the first result for that skill)
        if (skillResults.length === 1) {
          if (r.pluginName) {
            const group = r.pluginName;
            if (!groupedResults[group]) groupedResults[group] = [];
            // We'll store just one entry per skill here to drive the loop
            groupedResults[group].push(r);
          } else {
            ungroupedResults.push(r);
          }
        }
      }

      const skillCount = bySkill.size;
      const symlinkFailures = successful.filter((r) => r.mode === 'symlink' && r.symlinkFailed);
      const copiedAgents = symlinkFailures.map((r) => r.agent);
      const resultLines: string[] = [];

      const printSkillResults = (entries: typeof results) => {
        for (const entry of entries) {
          const skillResults = bySkill.get(entry.skill) || [];
          const firstResult = skillResults[0]!;

          if (firstResult.mode === 'copy') {
            // Copy mode: group identical install paths to avoid repeated output
            resultLines.push(`${pc.green('✓')} ${entry.skill} ${pc.dim('(copied)')}`);
            resultLines.push(...buildCopyResultLines(skillResults, cwd));
          } else {
            // Symlink mode: show canonical path and universal/symlinked agents
            if (firstResult.canonicalPath) {
              const shortPath = shortenPath(firstResult.canonicalPath, cwd);
              resultLines.push(`${pc.green('✓')} ${shortPath}`);
            } else {
              resultLines.push(`${pc.green('✓')} ${entry.skill}`);
            }
            resultLines.push(...buildResultLines(skillResults, targetAgents));
          }
        }
      };

      // Print grouped results
      const sortedResultGroups = Object.keys(groupedResults).sort();

      for (const group of sortedResultGroups) {
        const title = group
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');

        resultLines.push('');
        resultLines.push(pc.bold(title));
        printSkillResults(groupedResults[group]!);
      }

      if (ungroupedResults.length > 0) {
        if (sortedResultGroups.length > 0) {
          resultLines.push('');
          resultLines.push(pc.bold('General'));
        }
        printSkillResults(ungroupedResults);
      }

      const title = pc.green(`Installed ${skillCount} skill${skillCount !== 1 ? 's' : ''}`);
      p.note(resultLines.join('\n'), title);

      // Show symlink failure warning (only for symlink mode)
      if (symlinkFailures.length > 0) {
        p.log.warn(pc.yellow(`Symlinks failed for: ${formatList(copiedAgents)}`));
        p.log.message(
          pc.dim(
            '  Files were copied instead. On Windows, enable Developer Mode for symlink support.'
          )
        );
      }
    }

    if (failed.length > 0) {
      console.log();
      p.log.error(pc.red(`Failed to install ${failed.length}`));
      for (const r of failed) {
        p.log.message(`  ${pc.red('✗')} ${r.skill} → ${r.agent}: ${pc.dim(r.error)}`);
      }
    }

    console.log();
    p.outro(
      pc.green('Done!') +
        pc.dim('  Review skills before use; they run with full agent permissions.')
    );

    // Prompt for find-skills after successful install
    await promptForFindSkills(options, targetAgents);
  } catch (error) {
    if (error instanceof GitCloneError) {
      p.log.error(pc.red('Failed to clone repository'));
      // Print each line of the error message separately for better formatting
      for (const line of error.message.split('\n')) {
        p.log.message(pc.dim(line));
      }
    } else {
      p.log.error(error instanceof Error ? error.message : 'Unknown error occurred');
    }
    showInstallTip();
    p.outro(pc.red('Installation failed'));
    process.exit(1);
  } finally {
    await cleanup(tempDir);
  }
}

// Cleanup helper
async function cleanup(tempDir: string | null) {
  if (tempDir) {
    try {
      await cleanupTempDir(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Prompt user to install the find-skills skill after their first installation.
 */
async function promptForFindSkills(
  options?: AddOptions,
  targetAgents?: AgentType[]
): Promise<void> {
  // Skip if already dismissed or not in interactive mode
  if (!process.stdin.isTTY) return;
  if (options?.yes) return;

  try {
    const dismissed = await isPromptDismissed('findSkillsPrompt');
    if (dismissed) return;

    // Check if find-skills is already installed
    const findSkillsInstalled = await isSkillInstalled('find-skills', 'claude-code', {
      global: true,
    });
    if (findSkillsInstalled) {
      // Mark as dismissed so we don't check again
      await dismissPrompt('findSkillsPrompt');
      return;
    }

    console.log();
    p.log.message(pc.dim("One-time prompt - you won't be asked again if you dismiss."));
    const install = await p.confirm({
      message: `Install the ${pc.cyan('find-skills')} skill? It helps your agent discover and suggest skills.`,
    });

    if (p.isCancel(install)) {
      await dismissPrompt('findSkillsPrompt');
      return;
    }

    if (install) {
      // Install find-skills to the same agents the user selected, excluding replit
      await dismissPrompt('findSkillsPrompt');

      // Filter out replit from target agents
      const findSkillsAgents = targetAgents?.filter((a) => a !== 'replit');

      // Skip if no valid agents remain after filtering
      if (!findSkillsAgents || findSkillsAgents.length === 0) {
        return;
      }

      console.log();
      p.log.step('Installing find-skills skill...');

      try {
        // Call runAdd directly
        await runAdd(['vercel-labs/skills'], {
          skill: ['find-skills'],
          global: true,
          yes: true,
          agent: findSkillsAgents,
        });
      } catch {
        p.log.warn('Failed to install find-skills. You can try again with:');
        p.log.message(pc.dim('  npx wittyhub add vercel-labs/skills@find-skills -g -y --all'));
      }
    } else {
      // User declined - dismiss the prompt
      await dismissPrompt('findSkillsPrompt');
      p.log.message(
        pc.dim('You can install it later with: npx wittyhub add vercel-labs/skills@find-skills')
      );
    }
  } catch {
    // Don't fail the main installation if prompt fails
  }
}

// Parse command line options from args array
export function parseAddOptions(args: string[]): { source: string[]; options: AddOptions } {
  const options: AddOptions = {};
  const source: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-g' || arg === '--global') {
      options.global = true;
    } else if (arg === '-y' || arg === '--yes') {
      options.yes = true;
    } else if (arg === '-l' || arg === '--list') {
      options.list = true;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '-a' || arg === '--agent') {
      options.agent = options.agent || [];
      i++;
      let nextArg = args[i];
      while (i < args.length && nextArg && !nextArg.startsWith('-')) {
        options.agent.push(nextArg);
        i++;
        nextArg = args[i];
      }
      i--; // Back up one since the loop will increment
    } else if (arg === '-s' || arg === '--skill') {
      options.skill = options.skill || [];
      i++;
      let nextArg = args[i];
      while (i < args.length && nextArg && !nextArg.startsWith('-')) {
        options.skill.push(nextArg);
        i++;
        nextArg = args[i];
      }
      i--; // Back up one since the loop will increment
    } else if (arg === '--full-depth') {
      options.fullDepth = true;
    } else if (arg === '--copy') {
      options.copy = true;
    } else if (arg === '--subagent') {
      options.subagent = options.subagent || [];
      i++;
      let nextArg = args[i];
      while (i < args.length && nextArg && !nextArg.startsWith('-')) {
        options.subagent.push(nextArg);
        i++;
        nextArg = args[i];
      }
      i--; // Back up one since the loop will increment
    } else if (arg === '--dangerously-accept-openclaw-risks') {
      options.dangerouslyAcceptOpenclawRisks = true;
    } else if (arg && !arg.startsWith('-')) {
      source.push(arg);
    }
  }

  return { source, options };
}
