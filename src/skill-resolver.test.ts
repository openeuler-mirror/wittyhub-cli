import { describe, expect, it } from 'vitest';
import { normalizeSkillId, buildSkillId } from './skill-resolver.ts';

describe('normalizeSkillId', () => {
  it('passes through full skill ids with a source type prefix', () => {
    expect(normalizeSkillId('gitcode:vercel/agent-skills/.skills/deploy-to-vercel')).toBe(
      'gitcode:vercel/agent-skills/.skills/deploy-to-vercel'
    );
    expect(normalizeSkillId('github:vercel-labs/agent-skills/skills/deploy-to-vercel')).toBe(
      'github:vercel-labs/agent-skills/skills/deploy-to-vercel'
    );
  });

  it('prepends github: for shorthand without a source type prefix', () => {
    expect(normalizeSkillId('vercel-labs/agent-skills/skills/deploy-to-vercel')).toBe(
      'github:vercel-labs/agent-skills/skills/deploy-to-vercel'
    );
  });
});

describe('buildSkillId', () => {
  it('builds a skill id from sourceType, ownerRepo and skillName', () => {
    expect(buildSkillId('github', 'huggingface/transformers', 'add-or-fix-type-checking')).toBe(
      'github:huggingface/transformers/add-or-fix-type-checking'
    );
  });

  it('slugifies the ownerRepo and skillName', () => {
    expect(buildSkillId('github', 'HuggingFace/Transformers', 'Add Or Fix Type Checking')).toBe(
      'github:huggingface/transformers/add-or-fix-type-checking'
    );
  });

  it('uses skillFiles to derive the correct skill_path', () => {
    expect(
      buildSkillId('github', 'vercel-labs/agent-skills', 'deploy', {
        deploy: 'skills/deploy/SKILL.md',
      })
    ).toBe('github:vercel-labs/agent-skills/skills/deploy');
  });

  it('handles root-level SKILL.md', () => {
    expect(
      buildSkillId('github', 'vercel-labs/agent-skills', 'agent-skills', {
        'agent-skills': 'SKILL.md',
      })
    ).toBe('github:vercel-labs/agent-skills/agent-skills');
  });

  it('returns null for unsupported source types', () => {
    expect(buildSkillId('other', 'a/b', 'x')).toBeNull();
  });

  it('returns null for empty ownerRepo', () => {
    expect(buildSkillId('github', '', 'x')).toBeNull();
  });
});
