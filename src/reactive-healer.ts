import type { HealRequest } from './types.js';

type ValidationResult =
  | { ok: true; request: HealRequest }
  | { ok: false; error: string };

const REQUIRED_FIELDS = ['user', 'repo', 'repo_url', 'error'] as const;

export function validateHealPayload(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Payload must be a JSON object' };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.nanoclaw !== 'heal') {
    return { ok: false, error: 'nanoclaw field must be "heal"' };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!obj[field] && obj[field] !== 0) {
      return { ok: false, error: `Missing required field: ${field}` };
    }
  }

  const line = obj.line != null ? Number(obj.line) : undefined;

  const request: HealRequest = {
    nanoclaw: 'heal',
    user: String(obj.user),
    repo: String(obj.repo),
    repo_url: String(obj.repo_url),
    error: String(obj.error),
    traceback: obj.traceback != null ? String(obj.traceback) : undefined,
    file: obj.file != null ? String(obj.file) : undefined,
    line: line != null && !Number.isNaN(line) ? line : undefined,
    commit: obj.commit != null ? String(obj.commit) : undefined,
    severity: obj.severity === 'warning' ? 'warning' : 'error',
  };

  return { ok: true, request };
}
