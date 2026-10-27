import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCliOutput, stripLogo } from './test-utils.ts';

describe('init command', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `skills-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should initialize a skill and create SKILL.md', () => {
    const output = stripLogo(runCliOutput(['init', 'my-test-skill'], testDir));
    expect(output).toMatchInlineSnapshot(`
      "Initialized skill: my-test-skill

      Created:
        my-test-skill/SKILL.md

      Next steps:
        1. Edit my-test-skill/SKILL.md to define your skill instructions
        2. Update the name and description in the frontmatter
        3. Optionally set version and category (see the comment in my-test-skill/SKILL.md for the full list of categories)

      Publishing:
        Submit your skill to https://gitcode.com/openeuler/openEuler-skills

      Browse existing skills for inspiration at https://skillhub.openeuler.org/

      "
    `);

    const skillPath = join(testDir, 'my-test-skill', 'SKILL.md');
    expect(existsSync(skillPath)).toBe(true);

    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toMatchInlineSnapshot(`
      "---
      name: my-test-skill
      description: A brief description of what this skill does
      version: 0.1.0  # optional; increment as needed
      category: others  # optional;change if needed — full list at https://gitcode.com/openeuler/openEuler-skills
      ---

      # my-test-skill

      Instructions for the agent to follow when this skill is activated.

      ## When to use

      Describe when this skill should be used.

      ## Instructions

      1. First step
      2. Second step
      3. Additional steps as needed
      "
    `);
  });

  it('should allow multiple skills in same directory', () => {
    runCliOutput(['init', 'hydration-fix'], testDir);
    runCliOutput(['init', 'waterfall-data-fetching'], testDir);

    expect(existsSync(join(testDir, 'hydration-fix', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, 'waterfall-data-fetching', 'SKILL.md'))).toBe(true);
  });

  it('should default to my-skill subdirectory when no name provided', () => {
    const output = stripLogo(runCliOutput(['init'], testDir));

    expect(output).toContain('Initialized skill: my-skill');
    expect(output).toContain('Created:\n  my-skill/SKILL.md'); // in a subfolder, not directly in cwd
    expect(output).toContain('Publishing:');
    expect(output).toContain('Submit your skill to https://gitcode.com/openeuler/openEuler-skills');
    expect(existsSync(join(testDir, 'my-skill', 'SKILL.md'))).toBe(true);
  });

  it('should show publishing hints with skill path', () => {
    const output = stripLogo(runCliOutput(['init', 'my-skill'], testDir));

    expect(output).toContain('Publishing:');
    expect(output).toContain('Submit your skill to https://gitcode.com/openeuler/openEuler-skills');
    expect(output).toContain(
      'Browse existing skills for inspiration at https://skillhub.openeuler.org/'
    );
  });

  it('should show error if skill already exists', () => {
    runCliOutput(['init', 'existing-skill'], testDir);
    const output = stripLogo(runCliOutput(['init', 'existing-skill'], testDir));
    expect(output).toMatchInlineSnapshot(`
      "Skill already exists at existing-skill/SKILL.md
      "
    `);
  });
});
