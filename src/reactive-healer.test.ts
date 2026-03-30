import { describe, expect, it } from 'vitest';

import { validateHealPayload } from './reactive-healer.js';

describe('validateHealPayload', () => {
  const validPayload = {
    nanoclaw: 'heal',
    user: 'bjern',
    repo: 'datarake',
    repo_url: 'https://github.com/bjern/datarake',
    error: 'Client error 400',
  };

  it('accepts a valid payload with required fields only', () => {
    const result = validateHealPayload(validPayload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.user).toBe('bjern');
      expect(result.request.repo).toBe('datarake');
      expect(result.request.severity).toBe('error'); // default
    }
  });

  it('accepts a payload with all optional fields', () => {
    const full = {
      ...validPayload,
      traceback: 'File "foo.py", line 10',
      file: 'foo.py',
      line: 10,
      commit: 'abc123',
      severity: 'warning',
    };
    const result = validateHealPayload(full);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.file).toBe('foo.py');
      expect(result.request.line).toBe(10);
      expect(result.request.severity).toBe('warning');
    }
  });

  it('rejects when nanoclaw field is not "heal"', () => {
    const result = validateHealPayload({ ...validPayload, nanoclaw: 'other' });
    expect(result.ok).toBe(false);
  });

  it('rejects when nanoclaw field is missing', () => {
    const { nanoclaw, ...rest } = validPayload;
    const result = validateHealPayload(rest);
    expect(result.ok).toBe(false);
  });

  it('rejects when required fields are missing', () => {
    for (const field of ['user', 'repo', 'repo_url', 'error']) {
      const partial = { ...validPayload };
      delete (partial as any)[field];
      const result = validateHealPayload(partial);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(field);
      }
    }
  });

  it('rejects non-object input', () => {
    expect(validateHealPayload(null).ok).toBe(false);
    expect(validateHealPayload('string').ok).toBe(false);
    expect(validateHealPayload(42).ok).toBe(false);
  });

  it('coerces line to number', () => {
    const result = validateHealPayload({ ...validPayload, line: '305' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.line).toBe(305);
    }
  });
});
