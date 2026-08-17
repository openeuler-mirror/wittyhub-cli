import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAuditData } from './telemetry.ts';
import { getHighRiskSkills } from './add.ts';

describe('fetchAuditData', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls per-skill audit endpoint for each skill', async () => {
    const payload = {
      risk_level: 'low',
      risk_score: 10,
      risk_signals: [],
      audited_at: null,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));

    const result = await fetchAuditData('vercel-labs/agent-skills', ['deploy-to-vercel'], 'github');

    expect(result).toEqual({
      'deploy-to-vercel': {
        risk_level: 'low',
        risk_score: 10,
        risk_signals: [],
        audited_at: null,
      },
    });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain('/api/v1/skills/');
    expect(url).toContain('/audit');
    expect(url).toContain('deploy-to-vercel');
  });

  it('derives skill_id from skill_files when provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    await fetchAuditData('a/b', ['deploy-to-vercel'], 'github', {
      'deploy-to-vercel': 'skills/deploy-to-vercel/SKILL.md',
    });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain('/api/v1/skills/github/a/b/skills/deploy-to-vercel/audit');
  });

  it('returns null when response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchAuditData('a/b', ['x'], 'github')).toBeNull();
  });

  it('returns null when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
    expect(await fetchAuditData('a/b', ['x'], 'github')).toBeNull();
  });

  it('returns null when no skills provided', async () => {
    expect(await fetchAuditData('a/b', [], 'github')).toBeNull();
  });
});

describe('getHighRiskSkills', () => {
  const skills = [
    { slug: 'skill-a', displayName: 'Skill A' },
    { slug: 'skill-b', displayName: 'Skill B' },
    { slug: 'skill-c', displayName: 'Skill C' },
  ];

  it('returns names with actual risk levels for high/critical skills', () => {
    const audit = {
      'skill-a': { risk_level: 'high', risk_score: 80, risk_signals: [], audited_at: null },
      'skill-b': { risk_level: 'low', risk_score: 10, risk_signals: [], audited_at: null },
      'skill-c': { risk_level: 'critical', risk_score: 95, risk_signals: [], audited_at: null },
    } as never;
    expect(getHighRiskSkills(audit, skills)).toEqual([
      { name: 'Skill A', riskLevel: 'high' },
      { name: 'Skill C', riskLevel: 'critical' },
    ]);
  });

  it('ignores skills without audit data', () => {
    const audit = {
      'skill-b': { risk_level: 'safe', risk_score: 0, risk_signals: [], audited_at: null },
    } as never;
    expect(getHighRiskSkills(audit, skills)).toEqual([]);
  });

  it('returns empty when no audit data', () => {
    expect(getHighRiskSkills(null, skills)).toEqual([]);
  });
});
