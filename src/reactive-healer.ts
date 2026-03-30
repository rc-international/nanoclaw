import { logger } from "./logger.js";
import { parseTraceback } from "./traceback-parser.js";
import type { HealBatch, HealBatchEntry, HealRequest } from "./types.js";

type ValidationResult =
	| { ok: true; request: HealRequest }
	| { ok: false; error: string };

const REQUIRED_FIELDS = ["user", "repo", "repo_url", "error"] as const;

export function validateHealPayload(raw: unknown): ValidationResult {
	if (!raw || typeof raw !== "object") {
		return { ok: false, error: "Payload must be a JSON object" };
	}

	const obj = raw as Record<string, unknown>;

	if (obj.nanoclaw !== "heal") {
		return { ok: false, error: 'nanoclaw field must be "heal"' };
	}

	for (const field of REQUIRED_FIELDS) {
		if (!obj[field] && obj[field] !== 0) {
			return { ok: false, error: `Missing required field: ${field}` };
		}
	}

	const line = obj.line != null ? Number(obj.line) : undefined;

	const request: HealRequest = {
		nanoclaw: "heal",
		user: String(obj.user),
		repo: String(obj.repo),
		repo_url: String(obj.repo_url),
		error: String(obj.error),
		traceback: obj.traceback != null ? String(obj.traceback) : undefined,
		file: obj.file != null ? String(obj.file) : undefined,
		line: line != null && !Number.isNaN(line) ? line : undefined,
		commit: obj.commit != null ? String(obj.commit) : undefined,
		severity: obj.severity === "warning" ? "warning" : "error",
	};

	return { ok: true, request };
}

interface PendingBatch {
	user: string;
	repo: string;
	repo_url: string;
	sourceChannelJid: string;
	entries: Map<string, HealBatchEntry>; // keyed by "file:line:error"
	timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

export class HealDebouncer {
	private batches = new Map<string, PendingBatch>(); // keyed by "user:repo"
	private onBatch: (batch: HealBatch) => void;
	private debounceMs: number;

	constructor(
		onBatch: (batch: HealBatch) => void,
		debounceMs = DEFAULT_DEBOUNCE_MS,
	) {
		this.onBatch = onBatch;
		this.debounceMs = debounceMs;
	}

	add(request: HealRequest, sourceChannelJid: string): void {
		const key = `${request.user}:${request.repo}`;

		let batch = this.batches.get(key);
		if (batch) {
			clearTimeout(batch.timer);
		} else {
			batch = {
				user: request.user,
				repo: request.repo,
				repo_url: request.repo_url,
				sourceChannelJid,
				entries: new Map(),
				timer: null as any,
			};
			this.batches.set(key, batch);
		}

		// Resolve file + line: use explicit fields, fall back to traceback parsing
		let file = request.file;
		let line = request.line;
		if ((!file || !line) && request.traceback) {
			const frames = parseTraceback(request.traceback);
			if (frames.length > 0) {
				file = file || frames[0].file;
				line = line || frames[0].line;
			}
		}

		file = file || "unknown";
		line = line || 0;

		// Dedup key: same file + line + error message
		const entryKey = `${file}:${line}:${request.error}`;
		const existing = batch.entries.get(entryKey);
		if (existing) {
			existing.occurrences++;
		} else {
			batch.entries.set(entryKey, {
				file,
				line,
				error: request.error,
				traceback: request.traceback,
				commit: request.commit,
				occurrences: 1,
			});
		}

		batch.timer = setTimeout(() => this.fire(key), this.debounceMs);

		logger.debug(
			{ key, entryCount: batch.entries.size },
			"Added error to reactive heal batch",
		);
	}

	private fire(key: string): void {
		const batch = this.batches.get(key);
		if (!batch) return;

		this.batches.delete(key);

		const healBatch: HealBatch = {
			user: batch.user,
			repo: batch.repo,
			repo_url: batch.repo_url,
			sourceChannelJid: batch.sourceChannelJid,
			entries: Array.from(batch.entries.values()),
		};

		logger.info(
			{
				user: healBatch.user,
				repo: healBatch.repo,
				entries: healBatch.entries.length,
			},
			"Debounce timer fired, dispatching reactive heal batch",
		);

		this.onBatch(healBatch);
	}

	destroy(): void {
		for (const batch of this.batches.values()) {
			clearTimeout(batch.timer);
		}
		this.batches.clear();
	}
}
