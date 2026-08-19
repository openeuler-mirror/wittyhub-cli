import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseGetOptions,
  normalizeSkillId,
  buildSkillIdFromSource,
  resolveSkillIdBySourceAndName,
  fetchSkillDetail,
  buildGetOutput,
} from './get.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseGetOptions', () => {
  it('extracts the source and --skill', () => {
    expect(
      parseGetOptions([
        'https://github.com/huggingface/transformers',
        '--skill',
        'add-or-fix-type-checking',
      ])
    ).toEqual({
      source: 'https://github.com/huggingface/transformers',
      skill: 'add-or-fix-type-checking',
      errors: [],
    });
  });

  it('accepts the -s short flag for skill', () => {
    expect(parseGetOptions(['vercel-labs/agent-skills', '-s', 'deploy'])).toEqual({
      source: 'vercel-labs/agent-skills',
      skill: 'deploy',
      errors: [],
    });
  });

  it('keeps the first positional arg as source when no --skill is given', () => {
    expect(parseGetOptions(['github/a/b/skills/deploy'])).toEqual({
      source: 'github/a/b/skills/deploy',
      skill: '',
      errors: [],
    });
  });

  it('errors when no source is provided', () => {
    expect(parseGetOptions([])).toEqual({
      source: '',
      skill: '',
      errors: ['Missing source or skill id'],
    });
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

  it('resolves the skill id from a full GitHub URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => searchResults });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveSkillIdBySourceAndName(
        'https://github.com/huggingface/transformers',
        'add-or-fix-type-checking'
      )
    ).resolves.toBe('github/huggingface/transformers/.ai/skills/add-or-fix-type-checking');
  });

  it('resolves the skill id from an owner/repo shorthand', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => searchResults });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveSkillIdBySourceAndName('vercel-labs/agent-skills', 'deploy-to-vercel')
    ).resolves.toBe('github/vercel-labs/agent-skills/skills/deploy-to-vercel');
  });

  it('returns null when no result matches the source', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => searchResults });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveSkillIdBySourceAndName('https://github.com/unknown/repo', 'x')
    ).resolves.toBeNull();
  });

  it('returns null when the search request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(
      resolveSkillIdBySourceAndName('https://github.com/huggingface/transformers', 'x')
    ).resolves.toBeNull();
  });
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

describe('fetchSkillDetail', () => {
  it('calls the per-skill detail endpoint and maps the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skill_id: 'github/vercel-labs/agent-skills/skills/deploy-to-vercel',
        name: 'deploy-to-vercel',
        description: 'Deploy to Vercel from the CLI',
        author: 'vercel',
        category: 'Development and Build',
        version: '1.0.0',
        tags: ['deploy', 'vercel'],
        source: 'github',
        source_url: 'https://github.com/vercel-labs/agent-skills',
        download_count: 5,
        risk_score: 10,
        updated_at: '2026-08-18T00:00:00Z',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSkillDetail(
      'github/vercel-labs/agent-skills/skills/deploy-to-vercel'
    );

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe(
      '/api/v1/skills/github/vercel-labs/agent-skills/skills/deploy-to-vercel'
    );

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.author).toBe('vercel');
      expect(result.data.category).toBe('Development and Build');
      expect(result.data.version).toBe('1.0.0');
      expect(result.data.description).toBe('Deploy to Vercel from the CLI');
      expect(result.data.tags).toEqual(['deploy', 'vercel']);
      expect(result.data.download_count).toBe(5);
      expect(result.data.risk_score).toBe(10);
    }
  });

  it('returns an error when the response carries an error field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: 'Skill not found' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSkillDetail('github/a/b/skills/x');
    expect(result).toEqual({ status: 'error', message: 'Skill not found' });
  });

  it('returns not_found on HTTP 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSkillDetail('github/a/b/skills/x');
    expect(result).toEqual({ status: 'not_found' });
  });

  it('returns an error when the fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await fetchSkillDetail('github/a/b/skills/x');
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('无法连接详情服务');
    }
  });
});

describe('buildGetOutput', () => {
  const detail = {
    skill_id: 'github/vercel-labs/agent-skills/skills/deploy-to-vercel',
    name: 'deploy-to-vercel',
    description: 'Deploy to Vercel from the CLI',
    version: '1.0.0',
    commit_id: null,
    author: 'vercel',
    source: 'github',
    source_url: 'https://github.com/vercel-labs/agent-skills',
    repo_url: null,
    category: 'Development and Build',
    tags: ['deploy', 'vercel'],
    platform: 'personal',
    metadata: null,
    risk_score: 10,
    download_count: 5,
    period_downloads: null,
    rating: null,
    created_at: '2026-08-18T00:00:00Z',
    updated_at: '2026-08-18T00:00:00Z',
    last_indexed_at: null,
  };

  it('renders author, category, version, description and tags', () => {
    const output = buildGetOutput(detail).join('\n');
    expect(output).toContain('deploy-to-vercel');
    expect(output).toContain('Deploy to Vercel from the CLI');
    expect(output).toContain('vercel');
    expect(output).toContain('Development and Build');
    expect(output).toContain('1.0.0');
    expect(output).toContain('deploy, vercel');
    expect(output).toContain('5 installs');
    expect(output).toContain('safe risk');
  });

  it('omits optional fields when missing', () => {
    const output = buildGetOutput({ ...detail, author: null, category: null }).join('\n');
    expect(output).not.toContain('Author:');
    expect(output).not.toContain('Category:');
  });
});
