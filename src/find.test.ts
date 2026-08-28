import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFindOptions, searchSkillsAPI } from './find.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseFindOptions', () => {
  it('separates and normalizes an owner from a multi-word query', () => {
    expect(parseFindOptions(['react', 'native', '--owner', 'Vercel'])).toEqual({
      query: 'react native',
      options: { owner: 'vercel' },
      errors: [],
    });
  });

  it('supports the --owner=value form', () => {
    expect(parseFindOptions(['--owner=vercel-labs', 'next'])).toEqual({
      query: 'next',
      options: { owner: 'vercel-labs' },
      errors: [],
    });
  });

  it('rejects missing and invalid owners', () => {
    expect(parseFindOptions(['react', '--owner']).errors).toEqual(['--owner requires an owner']);
    expect(parseFindOptions(['react', '--owner', 'not/an/owner']).errors).toEqual([
      '--owner must be a valid owner',
    ]);
  });
});

describe('searchSkillsAPI', () => {
  it('calls the backend search endpoint with query and text mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], total: 0 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await searchSkillsAPI('react native');

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/api/v1/index/search');
    expect(url.searchParams.get('q')).toBe('react native');
    expect(url.searchParams.get('mode')).toBe('text');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('maps backend results to SearchSkill', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            skill_id: 'gitcode:vercel/agent-skills/deploy-to-vercel',
            name: 'deploy-to-vercel',
            description: 'Deploy to Vercel',
            source: 'gitcode',
            source_url: 'https://gitcode.com/vercel/agent-skills.git',
            download_count: 1234,
            risk_score: 85,
          },
          {
            skill_id: 'gitcode:other/repo/some-skill',
            name: 'some-skill',
            description: 'Another skill',
            source: 'gitcode',
            source_url: 'https://gitcode.com/other/repo.git',
            download_count: 10,
            risk_score: 15,
          },
        ],
        total: 2,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { skills } = await searchSkillsAPI('deploy');

    expect(skills).toHaveLength(2);
    expect(skills[0]).toMatchObject({
      name: 'deploy-to-vercel',
      slug: 'gitcode:vercel/agent-skills/deploy-to-vercel',
      source: 'gitcode',
      installs: 1234,
      description: 'Deploy to Vercel',
      riskScore: 85,
      sourceUrl: 'https://gitcode.com/vercel/agent-skills.git',
    });
    // Sorted by installs descending
    expect(skills[0]!.name).toBe('deploy-to-vercel');
  });

  it('filters results by owner extracted from source_url when owner is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            skill_id: 'gitcode:vercel/repo/skills/a',
            name: 'a',
            description: 'a',
            source: 'gitcode',
            source_url: 'https://gitcode.com/vercel/repo.git',
            download_count: 10,
            risk_score: 10,
          },
          {
            skill_id: 'gitcode:other/repo/skills/b',
            name: 'b',
            description: 'b',
            source: 'gitcode',
            source_url: 'https://gitcode.com/other/repo.git',
            download_count: 20,
            risk_score: 10,
          },
        ],
        total: 2,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { skills } = await searchSkillsAPI('x', 'vercel');

    expect(skills).toHaveLength(1);
    expect(skills[0]!.sourceUrl).toBe('https://gitcode.com/vercel/repo.git');
  });

  it('returns an error on non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchSkillsAPI('react')).resolves.toMatchObject({
      skills: [],
      error: expect.stringContaining('500'),
    });
  });

  it('returns an error on fetch failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchSkillsAPI('react')).resolves.toMatchObject({
      skills: [],
      error: expect.any(String),
    });
  });
});
