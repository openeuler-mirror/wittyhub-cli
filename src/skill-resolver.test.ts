import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeSkillId,
  buildSkillIdFromSource,
  listSkillsByRepo,
  resolveSkillIdBySourceAndName,
  resolveSkillId,
} from './skill-resolver.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeSkillId', () => {
  it('passes through full skill ids with a source type prefix', () => {
    expect(normalizeSkillId('gitcode/vercel/agent-skills/.skills/deploy-to-vercel')).toBe(
      'gitcode/vercel/agent-skills/.skills/deploy-to-vercel'
    );
    expect(normalizeSkillId('github/vercel-labs/agent-skills/skills/deploy-to-vercel')).toBe(
      'github/vercel-labs/agent-skills/skills/deploy-to-vercel'
    );
  });

  it('prepends github/ for shorthand without a source type prefix', () => {
    expect(normalizeSkillId('vercel-labs/agent-skills/skills/deploy-to-vercel')).toBe(
      'github/vercel-labs/agent-skills/skills/deploy-to-vercel'
    );
  });
});

describe('buildSkillIdFromSource', () => {
  it('builds a skill id from a GitHub URL and skill name', () => {
    expect(
      buildSkillIdFromSource(
        'https://github.com/huggingface/transformers',
        'add-or-fix-type-checking'
      )
    ).toBe('github/huggingface/transformers/add-or-fix-type-checking');
  });

  it('builds a skill id from owner/repo shorthand', () => {
    expect(buildSkillIdFromSource('vercel-labs/agent-skills', 'deploy-to-vercel')).toBe(
      'github/vercel-labs/agent-skills/deploy-to-vercel'
    );
  });

  it('keeps gitcode source type from a gitcode URL', () => {
    expect(buildSkillIdFromSource('https://gitcode.com/vercel/agent-skills', 'deploy')).toBe(
      'gitcode/vercel/agent-skills/deploy'
    );
  });

  it('returns null for sources without a supported source type', () => {
    expect(buildSkillIdFromSource('https://example.com/foo', 'x')).toBeNull();
  });

  it('returns null when the source has no owner/repo', () => {
    expect(buildSkillIdFromSource('/tmp/local/path', 'x')).toBeNull();
  });
});

describe('listSkillsByRepo', () => {
  const repoSkills = {
    skills: [
      {
        skill_id: 'github/huggingface/transformers/.ai/skills/add-or-fix-type-checking',
        name: 'add-or-fix-type-checking',
        source_url: 'https://github.com/huggingface/transformers',
      },
      {
        skill_id: 'github/huggingface/transformers/.ai/skills/code-review',
        name: 'code-review',
        source_url: 'https://github.com/huggingface/transformers',
      },
    ],
  };

  it('calls the list endpoint with source_type and repo filters', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => repoSkills });
    vi.stubGlobal('fetch', fetchMock);

    const skills = await listSkillsByRepo('https://github.com/huggingface/transformers');

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/api/v1/skills/');
    expect(url.searchParams.get('source_type')).toBe('github');
    expect(url.searchParams.get('repo')).toBe('huggingface/transformers');
    expect(url.searchParams.get('limit')).toBe('100');

    expect(skills).toHaveLength(2);
    expect(skills[0]!.skill_id).toContain('add-or-fix-type-checking');
  });

  it('returns an empty array when the list request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(listSkillsByRepo('https://github.com/huggingface/transformers')).resolves.toEqual(
      []
    );
  });

  it('returns an empty array for sources without a supported source type', async () => {
    await expect(listSkillsByRepo('https://example.com/foo')).resolves.toEqual([]);
  });
});

describe('resolveSkillIdBySourceAndName', () => {
  const searchResults = {
    results: [
      {
        skill_id: 'github/huggingface/transformers/.ai/skills/add-or-fix-type-checking',
        name: 'add-or-fix-type-checking',
        source_url:
          'https://github.com/huggingface/transformers/blob/main/.ai/skills/add-or-fix-type-checking/SKILL.md',
      },
      {
        skill_id: 'github/vercel-labs/agent-skills/skills/deploy-to-vercel',
        name: 'deploy-to-vercel',
        source_url:
          'https://github.com/vercel-labs/agent-skills/blob/main/skills/deploy-to-vercel/SKILL.md',
      },
    ],
  };

  it('resolves via the repo list endpoint with an exact name match', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skills: [
          {
            skill_id: 'github/huggingface/transformers/.ai/skills/add-or-fix-type-checking',
            name: 'add-or-fix-type-checking',
            source_url: 'https://github.com/huggingface/transformers',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveSkillIdBySourceAndName(
        'https://github.com/huggingface/transformers',
        'add-or-fix-type-checking'
      )
    ).resolves.toBe('github/huggingface/transformers/.ai/skills/add-or-fix-type-checking');

    // 只应请求列表接口，不应回退搜索
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('matches by the slugified last path segment when names differ slightly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skills: [
          {
            skill_id: 'github/huggingface/transformers/.ai/skills/add-or-fix-type-checking',
            name: 'Add Or Fix Type Checking',
            source_url: 'https://github.com/huggingface/transformers',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveSkillIdBySourceAndName(
        'https://github.com/huggingface/transformers',
        'add-or-fix-type-checking'
      )
    ).resolves.toBe('github/huggingface/transformers/.ai/skills/add-or-fix-type-checking');
  });

  it('returns null when the repo list is non-empty but no skill matches', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skills: [
          {
            skill_id: 'github/huggingface/transformers/.ai/skills/other-skill',
            name: 'other-skill',
            source_url: 'https://github.com/huggingface/transformers',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveSkillIdBySourceAndName('https://github.com/huggingface/transformers', 'missing-skill')
    ).resolves.toBeNull();
    // 仓库列表非空时不应再回退到搜索接口
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the search endpoint when the repo list is empty', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ skills: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => searchResults });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveSkillIdBySourceAndName(
        'https://github.com/huggingface/transformers',
        'add-or-fix-type-checking'
      )
    ).resolves.toBe('github/huggingface/transformers/.ai/skills/add-or-fix-type-checking');
  });

  it('resolves the skill id from an owner/repo shorthand via search fallback', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ skills: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => searchResults });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveSkillIdBySourceAndName('vercel-labs/agent-skills', 'deploy-to-vercel')
    ).resolves.toBe('github/vercel-labs/agent-skills/skills/deploy-to-vercel');
  });

  it('returns null when the search request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(
      resolveSkillIdBySourceAndName('https://github.com/huggingface/transformers', 'x')
    ).resolves.toBeNull();
  });
});

describe('resolveSkillId', () => {
  it('normalizes a direct skill id when no --skill is given', async () => {
    await expect(
      resolveSkillId('vercel-labs/agent-skills/skills/deploy-to-vercel')
    ).resolves.toEqual({
      skillId: 'github/vercel-labs/agent-skills/skills/deploy-to-vercel',
      derived: false,
    });
  });

  it('returns the resolved skill id when the repo list matches', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skills: [
          {
            skill_id: 'github/huggingface/transformers/.ai/skills/add-or-fix-type-checking',
            name: 'add-or-fix-type-checking',
            source_url: 'https://github.com/huggingface/transformers',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveSkillId('https://github.com/huggingface/transformers', 'add-or-fix-type-checking')
    ).resolves.toEqual({
      skillId: 'github/huggingface/transformers/.ai/skills/add-or-fix-type-checking',
      derived: false,
    });
  });

  it('falls back to a derived id when the skill cannot be located', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skills: [
          {
            skill_id: 'github/huggingface/transformers/.ai/skills/other-skill',
            name: 'other-skill',
            source_url: 'https://github.com/huggingface/transformers',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveSkillId('https://github.com/huggingface/transformers', 'missing-skill')
    ).resolves.toEqual({
      skillId: 'github/huggingface/transformers/missing-skill',
      derived: true,
    });
  });

  it('returns null when the source cannot be resolved at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(resolveSkillId('https://example.com/foo', 'x')).resolves.toEqual({
      skillId: null,
      derived: false,
    });
  });
});
