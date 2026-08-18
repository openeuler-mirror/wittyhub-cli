import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseAuditOptions,
  normalizeSkillId,
  buildSkillIdFromSource,
  resolveSkillIdBySourceAndName,
  fetchSkillAudit,
  buildAuditOutput,
} from './audit.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseAuditOptions', () => {
  it('extracts the source and --skill', () => {
    expect(
      parseAuditOptions([
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
    expect(parseAuditOptions(['vercel-labs/agent-skills', '-s', 'deploy'])).toEqual({
      source: 'vercel-labs/agent-skills',
      skill: 'deploy',
      errors: [],
    });
  });

  it('keeps the first positional arg as source when no --skill is given', () => {
    expect(parseAuditOptions(['github/a/b/skills/deploy'])).toEqual({
      source: 'github/a/b/skills/deploy',
      skill: '',
      errors: [],
    });
  });

  it('errors when no source is provided', () => {
    expect(parseAuditOptions([])).toEqual({
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

  it('returns null when the source has no owner/repo', () => {
    expect(buildSkillIdFromSource('/tmp/local/path', 'x')).toBeNull();
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

describe('fetchSkillAudit', () => {
  it('calls the per-skill audit endpoint and maps the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        risk_level: 'high',
        risk_score: 85,
        risk_signals: [
          { id: 's1', name: 'eval usage', description: 'Uses eval', severity: 'high' },
        ],
        audited_at: '2026-08-18T00:00:00Z',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSkillAudit('github/vercel-labs/agent-skills/skills/deploy-to-vercel');

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe(
      '/api/v1/skills/github/vercel-labs/agent-skills/skills/deploy-to-vercel/audit'
    );

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.risk_level).toBe('high');
      expect(result.data.risk_score).toBe(85);
      expect(result.data.risk_signals).toHaveLength(1);
      expect(result.data.risk_signals[0]!.name).toBe('eval usage');
      expect(result.data.audited_at).toBe('2026-08-18T00:00:00Z');
    }
  });

  it('returns no_audit when the response carries an error field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: 'No audit found' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSkillAudit('github/a/b/skills/x');
    expect(result).toEqual({ status: 'no_audit', message: 'No audit found' });
  });

  it('returns not_found on HTTP 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSkillAudit('github/a/b/skills/x');
    expect(result).toEqual({ status: 'not_found' });
  });

  it('returns an error when the fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await fetchSkillAudit('github/a/b/skills/x');
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('无法连接审计服务');
    }
  });
});

describe('buildAuditOutput', () => {
  it('renders risk level and risk signals', () => {
    const lines = buildAuditOutput('github/a/b/skills/x', {
      risk_level: 'high',
      risk_score: 85,
      risk_signals: [{ id: 's1', name: 'eval usage', description: 'Uses eval', severity: 'high' }],
      audited_at: '2026-08-18T00:00:00Z',
    });

    expect(lines.join('\n')).toContain('Skill:');
    expect(lines.join('\n')).toContain('github/a/b/skills/x');
    expect(lines.join('\n')).toContain('High');
    expect(lines.join('\n')).toContain('85');
    expect(lines.join('\n')).toContain('Risk signals:');
    expect(lines.join('\n')).toContain('eval usage');
    expect(lines.join('\n')).toContain('Uses eval');
  });

  it('colors the score with the same color as the risk level', () => {
    const lines = buildAuditOutput('github/a/b/skills/x', {
      risk_level: 'high',
      risk_score: 85,
      risk_signals: [],
      audited_at: null,
    });
    // picocolors red = \x1b[31m ... \x1b[39m，风险标签与 score 都应为红色
    const riskLine = lines.find((l) => l.includes('Risk:'))!;
    expect(riskLine).toContain('\x1b[31m(score 85)\x1b[39m');
    expect(riskLine).toContain('\x1b[31mHigh\x1b[39m');
  });

  it('renders a no-signals message when the list is empty', () => {
    const lines = buildAuditOutput('github/a/b/skills/x', {
      risk_level: 'safe',
      risk_score: 0,
      risk_signals: [],
      audited_at: null,
    });
    expect(lines.join('\n')).toContain('No risk signals detected.');
  });
});
