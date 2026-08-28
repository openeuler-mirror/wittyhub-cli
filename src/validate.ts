import { stat, readFile, readdir } from 'fs/promises';
import { join, basename, dirname, resolve } from 'path';
import pc from 'picocolors';
import { parseFrontmatter } from './frontmatter.ts';

// ─── validate command ───
// 校验本地 skill 目录是否符合规范。
// 用法：
//   wittyhub validate <path-to-skill-dir-or-SKILL.md>
//   wittyhub validate ./my-skill
//   wittyhub validate ./my-skill/SKILL.md

export interface ValidateOptions {
  json?: boolean;
}

export type Severity = 'error' | 'warning';

export interface ValidationRule {
  id: string;
  severity: Severity;
  message: string;
  hint?: string;
}

export interface ValidationResult {
  path: string;
  errors: ValidationRule[];
  warnings: ValidationRule[];
  ok: boolean;
}

const CANONICAL_CATEGORIES = new Set<string>([
  'Research and Design',
  'Development and Build',
  'Engineering and Compilation',
  'Quality and Validation',
  'Release and Deployment',
  'Monitoring and Operations',
  'Performance Optimization',
  'Security Hardening',
  'others',
]);

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

/** 把命令行参数解析为 path + options */
export function parseValidateOptions(args: string[]): {
  path: string;
  options: ValidateOptions;
  errors: string[];
} {
  let path = '';
  const options: ValidateOptions = {};
  const errors: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '-h' || arg === '--help') {
      // handled by caller; ignore here
    } else if (arg && !arg.startsWith('-')) {
      if (!path) {
        path = arg.trim();
      } else {
        errors.push(`Unexpected argument: ${arg}`);
      }
    } else if (arg) {
      errors.push(`Unknown option: ${arg}`);
    }
  }

  if (!path) {
    errors.push('Missing required argument: <path>');
  }
  return { path, options, errors };
}

/** 入口：校验一个本地 skill 目录或 SKILL.md 文件 */
export async function runValidate(args: string[]): Promise<ValidationResult | null> {
  const { path, options, errors } = parseValidateOptions(args);

  if (errors.length > 0) {
    for (const e of errors) {
      console.error(pc.red(`error: ${e}`));
    }
    console.error(`\nRun ${pc.cyan('wittyhub validate --help')} for usage.\n`);
    return null;
  }

  const absPath = resolve(path);
  const result = await validateSkill(absPath);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }
  return result;
}

/** 主校验逻辑：返回结构化结果（不打印） */
export async function validateSkill(absPath: string): Promise<ValidationResult> {
  const errors: ValidationRule[] = [];
  const warnings: ValidationRule[] = [];
  let skillDir = absPath;
  let skillMdPath: string | null = null;

  // 1) 路径存在性 + 类型判定
  let stats;
  try {
    stats = await stat(absPath);
  } catch {
    errors.push({
      id: 'path-not-found',
      severity: 'error',
      message: `Path does not exist: ${absPath}`,
      hint: 'Pass the skill directory (e.g. ./my-skill) or the SKILL.md file path.',
    });
    return { path: absPath, errors, warnings, ok: false };
  }

  if (stats.isFile()) {
    // 用户传的是文件路径 — 必须正好叫 SKILL.md
    const filename = basename(absPath);
    if (filename !== 'SKILL.md') {
      errors.push({
        id: 'filename-must-be-skill-md',
        severity: 'error',
        message: `File must be named "SKILL.md" (got "${filename}")`,
        hint: 'Rename the file to SKILL.md (uppercase). The agent skill spec requires this exact filename.',
      });
      return { path: absPath, errors, warnings, ok: false };
    }
    skillMdPath = absPath;
    skillDir = dirname(absPath);
  } else if (stats.isDirectory()) {
    // 用户传的是目录 — 在其中查找 SKILL.md（必须正好叫这个名字）
    const expected = join(absPath, 'SKILL.md');
    try {
      await stat(expected);
      skillMdPath = expected;
    } catch {
      errors.push({
        id: 'missing-skill-md',
        severity: 'error',
        message: `No SKILL.md found in directory: ${absPath}`,
        hint: 'Create one with `wittyhub init <name>` or rename an existing markdown file to SKILL.md (uppercase).',
      });
      return { path: absPath, errors, warnings, ok: false };
    }
  } else {
    errors.push({
      id: 'path-invalid-type',
      severity: 'error',
      message: `Path is neither a file nor a directory: ${absPath}`,
    });
    return { path: absPath, errors, warnings, ok: false };
  }

  // 2) 目录名大小写敏感校验 — 检查同级是否有 SKILL.md 之外的"skill.md"等大小写变体
  try {
    const entries = await readdir(skillDir);
    const lowerMdFile = entries.find((e) => e.toLowerCase() === 'skill.md' && e !== 'SKILL.md');
    if (lowerMdFile) {
      warnings.push({
        id: 'case-variant-found',
        severity: 'warning',
        message: `Found a case-variant file "${lowerMdFile}" alongside SKILL.md`,
        hint: 'Only "SKILL.md" (all uppercase) is recognized by the agent spec. Remove the variant to avoid confusion.',
      });
    }
  } catch {
    // ignore readdir failures
  }

  // 3) 读取 SKILL.md 内容
  const content = await readFile(skillMdPath, 'utf-8');

  // 4) Frontmatter 存在 + 闭合
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    errors.push({
      id: 'frontmatter-missing',
      severity: 'error',
      message: 'SKILL.md must start with a YAML frontmatter block delimited by "---"',
      hint: 'Add a frontmatter block at the top:\n\n  ---\n  name: my-skill\n  description: what it does\n  ---',
    });
    return { path: skillMdPath!, errors, warnings, ok: false };
  }

  const fmRaw = match[1]!;
  const body = match[2] ?? '';
  const { data: fm } = parseFrontmatter(content);

  // 5) Frontmatter 可解析为对象（防止 YAML 顶层是字符串/数组）
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
    errors.push({
      id: 'frontmatter-not-object',
      severity: 'error',
      message: 'Frontmatter must be a YAML mapping (key-value pairs), not a scalar or list.',
    });
    return { path: skillMdPath!, errors, warnings, ok: false };
  }

  // 6) 必填字段 name
  if (fm.name === undefined || fm.name === null || fm.name === '') {
    errors.push({
      id: 'name-required',
      severity: 'error',
      message: 'Missing required frontmatter field: name',
      hint: 'Add `name: <skill-name>` to the frontmatter.',
    });
  } else if (typeof fm.name !== 'string') {
    errors.push({
      id: 'name-not-string',
      severity: 'error',
      message: `Frontmatter field "name" must be a string (got ${typeof fm.name})`,
      hint: 'Wrap the value in quotes if it contains special characters.',
    });
  } else {
    // name 规范：kebab-case 小写
    if (!NAME_PATTERN.test(fm.name)) {
      warnings.push({
        id: 'name-not-kebab',
        severity: 'warning',
        message: `Skill name "${fm.name}" is not in kebab-case (lowercase letters, digits, hyphens)`,
        hint: 'Use a name like "add-or-fix-type-checking" for best compatibility.',
      });
    }
    // name 不应等于目录名变体（目录名 = skill 名更规范）
    if (basename(skillDir) !== fm.name) {
      warnings.push({
        id: 'name-dirname-mismatch',
        severity: 'warning',
        message: `Skill name "${fm.name}" does not match directory name "${basename(skillDir)}"`,
        hint: 'For consistency, the directory name and `name` field should match.',
      });
    }
  }

  // 7) 必填字段 description
  if (fm.description === undefined || fm.description === null || fm.description === '') {
    errors.push({
      id: 'description-required',
      severity: 'error',
      message: 'Missing required frontmatter field: description',
      hint: 'Add `description: <one-line summary>` to the frontmatter.',
    });
  } else if (typeof fm.description !== 'string') {
    errors.push({
      id: 'description-not-string',
      severity: 'error',
      message: `Frontmatter field "description" must be a string (got ${typeof fm.description})`,
    });
  } else {
    const desc = fm.description.trim();
    if (desc.length < 10) {
      warnings.push({
        id: 'description-too-short',
        severity: 'warning',
        message: `Description is very short (${desc.length} chars): "${desc}"`,
        hint: 'Aim for at least 10-20 characters so users can quickly understand the skill.',
      });
    }
    if (desc.length > 200) {
      warnings.push({
        id: 'description-too-long',
        severity: 'warning',
        message: `Description is very long (${desc.length} chars)`,
        hint: 'Keep it under 200 characters for readability in listings.',
      });
    }
  }

  // 8) 可选字段 category（如有，必须是规范分类）
  if (fm.category !== undefined && fm.category !== null) {
    if (typeof fm.category !== 'string') {
      warnings.push({
        id: 'category-not-string',
        severity: 'warning',
        message: `Frontmatter field "category" should be a string (got ${typeof fm.category})`,
      });
    } else if (!CANONICAL_CATEGORIES.has(fm.category)) {
      warnings.push({
        id: 'category-not-canonical',
        severity: 'warning',
        message: `Category "${fm.category}" is not in the canonical list`,
        hint: `Valid values: ${[...CANONICAL_CATEGORIES].join(', ')}. See https://gitcode.com/openeuler/openEuler-skills.`,
      });
    }
  }

  // 9) 可选字段 version（如有，必须是 semver）
  if (fm.version !== undefined && fm.version !== null && fm.version !== '') {
    if (typeof fm.version !== 'string') {
      warnings.push({
        id: 'version-not-string',
        severity: 'warning',
        message: `Frontmatter field "version" should be a string (got ${typeof fm.version})`,
        hint: 'Quote the value, e.g. `version: "1.0.0"`.',
      });
    } else if (!SEMVER_PATTERN.test(fm.version.trim())) {
      warnings.push({
        id: 'version-not-semver',
        severity: 'warning',
        message: `Version "${fm.version}" is not a valid semver`,
        hint: 'Use the form X.Y.Z (e.g. 1.0.0, 0.2.1-beta).',
      });
    }
  }

  // 10) 可选字段 metadata（如有，必须是对象）
  if (
    fm.metadata !== undefined &&
    (typeof fm.metadata !== 'object' || Array.isArray(fm.metadata))
  ) {
    warnings.push({
      id: 'metadata-not-object',
      severity: 'warning',
      message: `Frontmatter field "metadata" should be a mapping (got ${Array.isArray(fm.metadata) ? 'array' : typeof fm.metadata})`,
    });
  }

  // 11) Body 非空
  if (body.trim().length === 0) {
    warnings.push({
      id: 'body-empty',
      severity: 'warning',
      message: 'SKILL.md has no body content after the frontmatter',
      hint: 'Add at least a heading and a few instructions for the agent to follow.',
    });
  } else {
    // 12) Body 应包含至少一个 markdown 标题（## 等）
    if (!/^#{1,6}\s+\S/m.test(body)) {
      warnings.push({
        id: 'body-no-heading',
        severity: 'warning',
        message: 'Body content has no Markdown headings',
        hint: 'Structure the instructions with headings like `## When to use`, `## Instructions`.',
      });
    }
  }

  // 13) frontmatter 中不应出现未识别的字段（仅提醒，不算错）
  const knownKeys = new Set(['name', 'description', 'version', 'category', 'metadata']);
  const unknownKeys = Object.keys(fm).filter((k) => !knownKeys.has(k));
  if (unknownKeys.length > 0) {
    warnings.push({
      id: 'unknown-frontmatter-keys',
      severity: 'warning',
      message: `Unknown frontmatter keys: ${unknownKeys.join(', ')}`,
      hint: `Recognized keys: ${[...knownKeys].join(', ')}.`,
    });
  }

  return {
    path: skillMdPath!,
    errors,
    warnings,
    ok: errors.length === 0,
  };
}

function printResult(result: ValidationResult): void {
  const { path, errors, warnings, ok } = result;

  console.log(`${pc.cyan('Path:')} ${path}`);
  console.log();

  if (errors.length === 0 && warnings.length === 0) {
    console.log(pc.green('  All checks passed.'));
    console.log();
    return;
  }

  if (errors.length > 0) {
    console.log(pc.red(`${errors.length} error(s):`));
    for (const rule of errors) {
      console.log(`  ${pc.red('✗')} [${rule.id}] ${rule.message}`);
      if (rule.hint) {
        console.log(`    ${pc.dim(rule.hint)}`);
      }
    }
    console.log();
  }

  if (warnings.length > 0) {
    console.log(pc.yellow(`${warnings.length} warning(s):`));
    for (const rule of warnings) {
      console.log(`  ${pc.yellow('!')} [${rule.id}] ${rule.message}`);
      if (rule.hint) {
        console.log(`    ${pc.dim(rule.hint)}`);
      }
    }
    console.log();
  }

  if (ok) {
    console.log(
      pc.green('  Skill is valid.') +
        pc.yellow(
          warnings.length > 0
            ? ` (with ${warnings.length} warning${warnings.length > 1 ? 's' : ''})`
            : ''
        )
    );
  } else {
    console.log(pc.red('  Skill is NOT valid. Fix the errors above.'));
  }
  console.log();
}
