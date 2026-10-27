import * as readline from 'readline';
import { runAdd, parseAddOptions } from './add.ts';
import { sanitizeMetadata } from './sanitize.ts';
import { track } from './telemetry.ts';
import { isRunningInAgent } from './detect-agent.ts';
import { SEARCH_URL } from './config.ts';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[38;5;102m';
const TEXT = '\x1b[38;5;145m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';

function formatInstalls(count: number): string {
  if (count === undefined || count === null || Number.isNaN(count)) return '0';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(count);
}

/** 根据 risk_score 返回带颜色的风险等级（safe/low/medium/high，整串同色），未知时返回空串 */
function formatRiskLevel(riskScore: number | undefined): string {
  if (riskScore === undefined || riskScore === null) return '';
  if (riskScore <= 20) return `${GREEN}safe${RESET}`;
  if (riskScore <= 50) return `${GREEN}low${RESET}`;
  if (riskScore <= 80) return `${YELLOW}medium${RESET}`;
  return `${RED}high${RESET}`;
}

// key: value 输出的键名，按最长键（description:）补齐对齐
const KV_KEY_WIDTH = 'description:'.length;
function kvKey(key: string): string {
  return `${DIM}${key.padEnd(KV_KEY_WIDTH)}${RESET}`;
}

// 在文本中高亮匹配的搜索词（不区分大小写，支持多词）
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightMatches(text: string, query: string): string {
  if (!text || !query) return text;
  const terms = query.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (terms.length === 0) return text;
  // 使用品红色，与风险等级的颜色（绿/黄/红）区分开
  return text.replace(new RegExp(`(${terms.join('|')})`, 'gi'), `${MAGENTA}$1${RESET}`);
}

export interface SearchSkill {
  name: string;
  slug: string;
  source: string;
  installs: number;
  description?: string;
  riskScore?: number;
  sourceUrl?: string;
}

export interface SearchResult {
  skills: SearchSkill[];
  error?: string;
}

export interface FindOptions {
  owner?: string;
}

export interface ParseFindOptionsResult {
  query: string;
  options: FindOptions;
  errors: string[];
}

const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

export function parseFindOptions(args: string[]): ParseFindOptionsResult {
  const queryParts: string[] = [];
  const options: FindOptions = {};
  const errors: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    let ownerValue: string | undefined;
    if (arg === '--owner') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) {
        errors.push('--owner requires an owner');
        continue;
      }
      ownerValue = value;
      i++;
    } else if (arg.startsWith('--owner=')) {
      ownerValue = arg.slice('--owner='.length);
      if (!ownerValue) {
        errors.push('--owner requires an owner');
        continue;
      }
    } else {
      queryParts.push(arg);
      continue;
    }

    const owner = ownerValue.trim().toLowerCase();
    if (!GITHUB_OWNER_PATTERN.test(owner)) {
      errors.push('--owner must be a valid owner');
      continue;
    }
    options.owner = owner;
  }

  return { query: queryParts.join(' '), options, errors };
}

// 通过后端搜索接口查询技能
export async function searchSkillsAPI(query: string, owner?: string): Promise<SearchResult> {
  const params = new URLSearchParams({ q: query, limit: '10', mode: 'text' });
  const url = `${SEARCH_URL}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { skills: [], error: `无法连接搜索服务: ${SEARCH_URL}` };
  }

  if (!res.ok) {
    return { skills: [], error: `搜索服务返回 HTTP ${res.status}` };
  }

  let data: {
    // API wraps responses in { code, msg, data }; keep both shapes for
    // deployments without the wrapper.
    code?: number;
    msg?: string;
    data?: {
      results?: Array<{
        skill_id: string;
        name: string;
        description: string | null;
        source: string;
        source_url: string;
        download_count: number;
        risk_score: number | null;
      }>;
      total?: number;
    };
    results?: Array<{
      skill_id: string;
      name: string;
      description: string | null;
      source: string;
      source_url: string;
      download_count: number;
      risk_score: number | null;
    }>;
    total?: number;
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { skills: [], error: '搜索服务响应格式无效' };
  }

  const rawResults = data.data?.results ?? data.results ?? [];
  let skills = rawResults.map((skill) => ({
    name: sanitizeMetadata(skill.name),
    slug: sanitizeMetadata(skill.skill_id),
    source: sanitizeMetadata(skill.source || ''),
    installs: skill.download_count || 0,
    description: skill.description ? sanitizeMetadata(skill.description) : undefined,
    riskScore: skill.risk_score ?? undefined,
    sourceUrl: skill.source_url ? sanitizeMetadata(skill.source_url) : undefined,
  }));

  // 后端接口不支持 owner 过滤，这里在客户端按 source_url 中的 owner 过滤
  if (owner) {
    const ownerLower = owner.toLowerCase();
    skills = skills.filter((skill) => {
      if (skill.sourceUrl) {
        try {
          const u = new URL(skill.sourceUrl);
          const urlOwner = u.pathname.split('/').filter(Boolean)[0];
          if (urlOwner?.toLowerCase() === ownerLower) return true;
        } catch {
          // fall through to slug match
        }
      }
      return skill.slug.toLowerCase().includes(`/${ownerLower}/`);
    });
  }

  return { skills: skills.sort((a, b) => (b.installs || 0) - (a.installs || 0)) };
}

// ANSI escape codes for terminal control
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_DOWN = '\x1b[J';
const MOVE_UP = (n: number) => `\x1b[${n}A`;
const MOVE_TO_COL = (n: number) => `\x1b[${n}G`;

// Custom fzf-style search prompt using raw readline
async function runSearchPrompt(initialQuery = '', owner?: string): Promise<SearchSkill | null> {
  let results: SearchSkill[] = [];
  let selectedIndex = 0;
  let query = initialQuery;
  let loading = false;
  let searchError: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRenderedLines = 0;

  // Enable raw mode for keypress events
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  // Setup readline for keypress events but don't let it echo
  readline.emitKeypressEvents(process.stdin);

  // Resume stdin to start receiving events
  process.stdin.resume();

  // Hide cursor during selection
  process.stdout.write(HIDE_CURSOR);

  function render(): void {
    // Move cursor up to overwrite previous render
    if (lastRenderedLines > 0) {
      process.stdout.write(MOVE_UP(lastRenderedLines) + MOVE_TO_COL(1));
    }

    // Clear from cursor to end of screen (removes ghost trails)
    process.stdout.write(CLEAR_DOWN);

    const lines: string[] = [];

    // Search input line with cursor
    const cursor = `${BOLD}_${RESET}`;
    lines.push(`${TEXT}Search skills:${RESET} ${query}${cursor}`);
    lines.push('');

    // Results - keep showing existing results while loading new ones
    if (!query || query.length < 2) {
      lines.push(`${DIM}Start typing to search (min 2 chars)${RESET}`);
    } else if (results.length === 0 && loading) {
      lines.push(`${DIM}Searching...${RESET}`);
    } else if (results.length === 0 && searchError) {
      lines.push(`${RED}${searchError}${RESET}`);
    } else if (results.length === 0) {
      lines.push(`${DIM}No skills found${RESET}`);
    } else {
      // 每个结果 5 行（key: value 结构），条数过多会超出常见终端高度，
      // 收敛到 6 条控制整体渲染高度
      const maxVisible = 6;
      const visible = results.slice(0, maxVisible);

      for (let i = 0; i < visible.length; i++) {
        const skill = visible[i]!;
        const isSelected = i === selectedIndex;
        const arrow = isSelected ? `${BOLD}>${RESET}` : ' ';
        const hlName = highlightMatches(skill.name, query);
        const name = isSelected ? `${BOLD}${hlName}${RESET}` : `${TEXT}${hlName}${RESET}`;
        const risk = formatRiskLevel(skill.riskScore);
        const loadingIndicator = loading && i === 0 ? ` ${DIM}...${RESET}` : '';

        lines.push(`  ${arrow} ${kvKey('skill_name:')} ${name}${loadingIndicator}`);
        lines.push(`    ${kvKey('skill_id:')} ${CYAN}${skill.slug}${RESET}`);
        lines.push(`    ${kvKey('installs:')} ${CYAN}${formatInstalls(skill.installs)}${RESET}`);
        if (risk) {
          lines.push(`    ${kvKey('risk:')} ${risk}`);
        }
        if (skill.description) {
          const descPlain =
            skill.description.length > 80
              ? `${skill.description.slice(0, 77)}...`
              : skill.description;
          lines.push(
            `    ${kvKey('description:')} ${DIM}${highlightMatches(descPlain, query)}${RESET}`
          );
        }
      }
    }

    lines.push('');
    lines.push(`${DIM}up/down navigate | enter select | esc cancel${RESET}`);

    // Write each line
    for (const line of lines) {
      process.stdout.write(line + '\n');
    }

    lastRenderedLines = lines.length;
  }

  function triggerSearch(q: string): void {
    // Always clear any pending debounce timer
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    // Always reset loading state when starting a new search
    loading = false;

    if (!q || q.length < 2) {
      results = [];
      searchError = null;
      selectedIndex = 0;
      render();
      return;
    }

    // Use API search for all queries (debounced)
    loading = true;
    render();

    // Adaptive debounce: shorter queries = longer wait (user still typing)
    // 2 chars: 250ms, 3 chars: 200ms, 4 chars: 150ms, 5+ chars: 150ms
    const debounceMs = Math.max(150, 350 - q.length * 50);

    debounceTimer = setTimeout(async () => {
      try {
        const result = await searchSkillsAPI(q, owner);
        results = result.skills;
        searchError = result.error ?? null;
        selectedIndex = 0;
      } catch {
        results = [];
        searchError = null;
      } finally {
        loading = false;
        debounceTimer = null;
        render();
      }
    }, debounceMs);
  }

  // Trigger initial search if there's a query, then render
  if (initialQuery) {
    triggerSearch(initialQuery);
  }
  render();

  return new Promise((resolve) => {
    function cleanup(): void {
      process.stdin.removeListener('keypress', handleKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdout.write(SHOW_CURSOR);
      // Pause stdin to fully release it for child processes
      process.stdin.pause();
    }

    function handleKeypress(_ch: string | undefined, key: readline.Key): void {
      if (!key) return;

      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        // Cancel
        cleanup();
        resolve(null);
        return;
      }

      if (key.name === 'return') {
        // Submit
        cleanup();
        resolve(results[selectedIndex] || null);
        return;
      }

      if (key.name === 'up') {
        selectedIndex = Math.max(0, selectedIndex - 1);
        render();
        return;
      }

      if (key.name === 'down') {
        selectedIndex = Math.min(Math.max(0, results.length - 1), selectedIndex + 1);
        render();
        return;
      }

      if (key.name === 'backspace') {
        if (query.length > 0) {
          query = query.slice(0, -1);
          triggerSearch(query);
        }
        return;
      }

      // Regular character input
      if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
        const char = key.sequence;
        if (char >= ' ' && char <= '~') {
          query += char;
          triggerSearch(query);
        }
      }
    }

    process.stdin.on('keypress', handleKeypress);
  });
}

export async function runFind(args: string[]): Promise<void> {
  const { query, options: findOptions, errors } = parseFindOptions(args);
  const owner = findOptions.owner;
  const isNonInteractive = !process.stdin.isTTY;
  const agentTip = `${DIM}Tip: if running in a coding agent, follow these steps:${RESET}
${DIM}  1) npx wittyhub find [query] [--owner <owner>]${RESET}
${DIM}  2) npx wittyhub add <skill_id>${RESET}`;

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    console.error('Usage: npx wittyhub find <query> [--owner <owner>]');
    return;
  }

  // Non-interactive mode: just print results and exit
  if (query) {
    const { skills: results, error: searchError } = await searchSkillsAPI(query, owner);

    // Track telemetry for non-interactive search
    track({
      event: 'find',
      query,
      resultCount: String(results.length),
    });

    if (searchError) {
      console.error(`${RED}${searchError}${RESET}`);
      return;
    }

    if (results.length === 0) {
      const ownerSuffix = owner ? ` from owner "${owner}"` : '';
      console.log(`${DIM}No skills found for "${query}"${ownerSuffix}${RESET}`);
      return;
    }

    console.log(`${DIM}Install with${RESET} npx wittyhub add ${TEXT}<skill_id>${RESET}`);
    console.log();

    for (const skill of results.slice(0, 6)) {
      const hlName = highlightMatches(skill.name, query);
      const risk = formatRiskLevel(skill.riskScore);

      console.log(`${BOLD}●${RESET} ${kvKey('skill_name:')} ${BOLD}${hlName}${RESET}`);
      console.log(`  ${kvKey('skill_id:')} ${CYAN}${skill.slug}${RESET}`);
      console.log(`  ${kvKey('installs:')} ${CYAN}${formatInstalls(skill.installs)}${RESET}`);
      if (risk) {
        console.log(`  ${kvKey('risk:')} ${risk}`);
      }
      if (skill.description) {
        const descPlain =
          skill.description.length > 100
            ? `${skill.description.slice(0, 97)}...`
            : skill.description;
        console.log(
          `  ${kvKey('description:')} ${DIM}${highlightMatches(descPlain, query)}${RESET}`
        );
      }
      console.log();
    }
    return;
  }

  // Skip interactive search when running inside an AI agent or non-TTY
  if (isNonInteractive || (await isRunningInAgent())) {
    console.log(agentTip);
    console.log();
    console.log(`${DIM}Usage: npx wittyhub find <query> [--owner <owner>]${RESET}`);
    return;
  }

  const selected = await runSearchPrompt('', owner);

  // Track telemetry for interactive search
  track({
    event: 'find',
    query: '',
    resultCount: selected ? '1' : '0',
    interactive: '1',
  });

  if (!selected) {
    console.log(`${DIM}Search cancelled${RESET}`);
    console.log();
    return;
  }

  // Install via skill_id — consistent with the identifier shown in search
  // results and the recommended `wittyhub add <skill_id>` usage.
  const skillId = selected.slug;
  const skillName = selected.name;

  console.log();
  console.log(`${TEXT}Installing ${BOLD}${skillName}${RESET} ${DIM}(${skillId})${RESET}...`);
  console.log();

  // Run add directly since we're in the same CLI
  const { source, options: addOptions } = parseAddOptions([skillId]);
  await runAdd(source, addOptions);

  console.log();

  console.log(
    `${DIM}View the skill at${RESET} ${TEXT}https://skillhub.openeuler.org/skills/${selected.slug}${RESET}`
  );

  console.log();
}
