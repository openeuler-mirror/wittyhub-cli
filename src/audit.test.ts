import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAuditOptions, fetchSkillAudit, buildAuditOutput } from './audit.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseAuditOptions', () => {
  it('parses skill_id as the first positional arg', () => {
    expect(parseAuditOptions(['github:owner/repo/skill'])).toEqual({
      skillId: 'github:owner/repo/skill',
      errors: [],
    });
  });

  it('errors when no skill_id is provided', () => {
    expect(parseAuditOptions([])).toEqual({
      skillId: 'github:',
      errors: ['Missing skill id'],
    });
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

    const result = await fetchSkillAudit('github:vercel-labs/agent-skills/deploy-to-vercel');

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe(
      '/api/v1/skills/github:vercel-labs/agent-skills/deploy-to-vercel/audit'
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

    const result = await fetchSkillAudit('github:owner/repo/skill');
    expect(result).toEqual({ status: 'no_audit', message: 'No audit found' });
  });

  it('returns not_found on HTTP 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSkillAudit('github:owner/repo/skill');
    expect(result).toEqual({ status: 'not_found' });
  });

  it('returns an error when the fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await fetchSkillAudit('github:owner/repo/skill');
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('无法连接审计服务');
    }
  });
});

describe('buildAuditOutput', () => {
  it('renders risk level and risk signals', () => {
    const lines = buildAuditOutput('github:owner/repo/skill', {
      risk_level: 'high',
      risk_score: 85,
      risk_signals: [{ id: 's1', name: 'eval usage', description: 'Uses eval', severity: 'high' }],
      audited_at: '2026-08-18T00:00:00Z',
    });

    expect(lines.join('\n')).toContain('Skill:');
    expect(lines.join('\n')).toContain('github:owner/repo/skill');
    expect(lines.join('\n')).toContain('High');
    expect(lines.join('\n')).toContain('85');
    expect(lines.join('\n')).toContain('Risk signals:');
    expect(lines.join('\n')).toContain('eval usage');
    expect(lines.join('\n')).toContain('Uses eval');
  });

  it('colors the score with the same color as the risk level', () => {
    const lines = buildAuditOutput('github:owner/repo/skill', {
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
    const lines = buildAuditOutput('github:owner/repo/skill', {
      risk_level: 'safe',
      risk_score: 0,
      risk_signals: [],
      audited_at: null,
    });
    expect(lines.join('\n')).toContain('No risk signals detected.');
  });
});
