import type { ChildProcess } from "node:child_process";
import { runContainerAgent } from "./container-runner.js";
import { getUserProfileByLinuxUsername } from "./db.js";
import type { GroupQueue } from "./group-queue.js";
import { logger } from "./logger.js";
import { buildReactiveHealPrompt } from "./reactive-heal-prompt.js";
import {
	blameLineForSessionId,
	cleanupClone,
	cloneRepo,
} from "./repo-cloner.js";
import { parseTraceback } from "./traceback-parser.js";
import type {
	HealBatch,
	HealBatchEntry,
	HealRequest,
	RegisteredGroup,
} from "./types.js";

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

/**
 * Extract a heal JSON payload from a Discord message.
 * Checks for JSON code blocks (```json ... ```) and plain JSON objects
 * containing `"nanoclaw": "heal"`.
 */
export function extractHealPayload(
	content: string,
): Record<string, unknown> | null {
	// Try code block first
	const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (codeBlockMatch) {
		try {
			const parsed = JSON.parse(codeBlockMatch[1]);
			if (parsed?.nanoclaw === "heal") return parsed;
		} catch (e) {
			logger.debug({ error: e }, "Non-JSON content in code block");
		}
	}

	// Try plain JSON (find first { ... } containing "nanoclaw")
	const jsonMatch = content.match(/\{[^{}]*"nanoclaw"\s*:\s*"heal"[^{}]*\}/);
	if (jsonMatch) {
		try {
			return JSON.parse(jsonMatch[0]);
		} catch (e) {
			logger.debug({ error: e }, "Malformed JSON in message");
		}
	}

	return null;
}

export interface ReactiveHealerDeps {
	queue: GroupQueue;
	sendMessage: (jid: string, text: string) => Promise<void>;
	onProcess: (
		groupJid: string,
		proc: ChildProcess,
		containerName: string,
		groupFolder: string,
	) => void;
}

/**
 * Create the reactive healer instance. Returns:
 * - `handleMessage(content, channelJid)` — call from Discord handler
 * - `destroy()` — cleanup timers on shutdown
 */
export function createReactiveHealer(deps: ReactiveHealerDeps) {
	const debouncer = new HealDebouncer((batch) => {
		const taskId = `reactive-heal-${batch.user}-${batch.repo}-${Date.now()}`;
		deps.queue.enqueueTask(batch.sourceChannelJid, taskId, () =>
			executeReactiveHeal(batch, deps),
		);
	});

	return {
		handleMessage(content: string, channelJid: string): boolean {
			const raw = extractHealPayload(content);
			if (!raw) return false;

			const validation = validateHealPayload(raw);
			if (!validation.ok) {
				logger.warn(
					{ error: validation.error },
					"Invalid heal payload received",
				);
				deps
					.sendMessage(channelJid, `Invalid heal request: ${validation.error}`)
					.catch((e) =>
						logger.debug({ error: e }, "Failed to send validation error"),
					);
				return true; // consumed the message (even though invalid)
			}

			debouncer.add(validation.request, channelJid);
			return true; // consumed
		},

		destroy() {
			debouncer.destroy();
		},
	};
}

async function executeReactiveHeal(
	batch: HealBatch,
	deps: ReactiveHealerDeps,
): Promise<void> {
	const startTime = Date.now();

	// 1. Resolve user profile
	const profile = getUserProfileByLinuxUsername(batch.user);
	if (!profile) {
		logger.error({ user: batch.user }, "Unknown user for reactive heal");
		await deps.sendMessage(
			batch.sourceChannelJid,
			`Unknown user \`${batch.user}\` — register with the bot first.`,
		);
		return;
	}

	// 2. Clone the repo
	let cloneDir: string;
	try {
		cloneDir = await cloneRepo(
			batch.repo_url,
			batch.user,
			batch.repo,
			batch.entries[0]?.commit,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.error({ error: msg, repo: batch.repo_url }, "Failed to clone repo");
		await deps.sendMessage(
			batch.sourceChannelJid,
			`Failed to clone \`${batch.repo}\`: ${msg}`,
		);
		return;
	}

	try {
		// 3. Trace errors — run git blame for each entry
		let primarySessionId: string | undefined;
		for (const entry of batch.entries) {
			if (entry.file && entry.file !== "unknown" && entry.line > 0) {
				const blame = blameLineForSessionId(cloneDir, entry.file, entry.line);
				if (blame) {
					entry.blameCommit = blame.commitSha;
					if (blame.sessionId) {
						entry.sessionId = blame.sessionId;
						if (!primarySessionId) {
							primarySessionId = blame.sessionId;
						}
					}
				}
			}
		}

		// 4. Build prompt
		const prompt = buildReactiveHealPrompt(
			batch,
			`/workspace/extra/${batch.repo}`,
		);

		// 5. Build a temporary RegisteredGroup for the container
		const group: RegisteredGroup = {
			name: `reactive-heal-${batch.user}-${batch.repo}`,
			folder: `reactive-heal-${batch.user}`,
			trigger: /.*/,
			added_at: new Date().toISOString(),
			containerConfig: {
				userProfileId: profile.id,
				additionalMounts: [
					{
						hostPath: cloneDir,
						containerPath: batch.repo,
						readonly: false,
					},
				],
			},
		};

		// 6. Spawn container
		logger.info(
			{
				user: batch.user,
				repo: batch.repo,
				entries: batch.entries.length,
				sessionId: primarySessionId || "new",
			},
			"Spawning reactive heal container",
		);

		const output = await runContainerAgent(
			group,
			{
				prompt,
				sessionId: primarySessionId,
				groupFolder: group.folder,
				chatJid: batch.sourceChannelJid,
				isMain: false,
				isScheduledTask: true,
				assistantName: "NanoClaw Healer",
			},
			(proc, containerName) =>
				deps.onProcess(
					batch.sourceChannelJid,
					proc,
					containerName,
					group.folder,
				),
			async (streamedOutput) => {
				if (streamedOutput.result) {
					await deps.sendMessage(batch.sourceChannelJid, streamedOutput.result);
				}
			},
		);

		if (output.status === "error") {
			logger.error(
				{ error: output.error, repo: batch.repo },
				"Reactive heal container failed",
			);
		}

		logger.info(
			{
				user: batch.user,
				repo: batch.repo,
				durationMs: Date.now() - startTime,
				status: output.status,
			},
			"Reactive heal completed",
		);
	} finally {
		// 7. Cleanup
		cleanupClone(cloneDir);
	}
}
