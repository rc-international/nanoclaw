import { describe, it, expect } from 'vitest';
import { buildHealPrompt } from './heal-prompt.js';
import { RepoConfig } from './types.js';

const repo: RepoConfig = {
  name: 'api',
  localPath: '/home/alice/projects/api',
  inspectionTypes: ['log-analysis'],
  schedule: '0 23 * * *',
  healBranchPrefix: 'heal/',
};

describe('buildHealPrompt', () => {
  it('builds log-analysis prompt with repo and logs', () => {
    const prompt = buildHealPrompt(repo, 'log-analysis', {
      'prod-api': '/workspace/logs/prod-api',
    });
    expect(prompt).toContain('/workspace/extra/api');
    expect(prompt).toContain('/workspace/logs/prod-api');
    expect(prompt).toContain('heal/');
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('log-analysis');
  });

  it('builds code-review prompt without logs', () => {
    const prompt = buildHealPrompt(repo, 'code-review', {});
    expect(prompt).toContain('/workspace/extra/api');
    expect(prompt).not.toContain('/workspace/logs');
    expect(prompt).toContain('code quality');
  });

  it('builds security-review prompt', () => {
    const prompt = buildHealPrompt(repo, 'security-review', {});
    expect(prompt).toContain('OWASP');
    expect(prompt).toContain('vulnerabilities');
  });

  it('includes date in branch name', () => {
    const prompt = buildHealPrompt(repo, 'log-analysis', {});
    const today = new Date().toISOString().split('T')[0];
    expect(prompt).toContain(`heal/${today}`);
  });

  it('handles log-analysis with no logs gracefully', () => {
    const prompt = buildHealPrompt(repo, 'log-analysis', {});
    expect(prompt).toContain('/workspace/extra/api');
    // Should have fallback text about no logs
    expect(prompt).not.toContain('/workspace/logs');
  });
});
