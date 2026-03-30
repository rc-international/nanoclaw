import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { logger } from "./logger.js";

const CLONE_BASE = "/tmp/nanoclaw-heal";

export interface BlameResult {
	commitSha: string;
	sessionId: string | null;
}

/**
 * Clone a repo to a temp directory. Returns the clone path.
 * Uses shallow clone (50 commits) for speed while retaining
 * enough history for `git blame`.
 */
export async function cloneRepo(
	repoUrl: string,
	user: string,
	repo: string,
	commit?: string,
): Promise<string> {
	const timestamp = Date.now();
	const cloneDir = path.join(CLONE_BASE, user, `${repo}-${timestamp}`);
	fs.mkdirSync(path.dirname(cloneDir), { recursive: true });

	logger.info({ repoUrl, cloneDir }, "Cloning repo for reactive heal");

	execFileSync("git", ["clone", "--depth", "50", repoUrl, cloneDir], {
		timeout: 60_000,
		stdio: "pipe",
	});

	if (commit) {
		try {
			execFileSync("git", ["checkout", commit], {
				cwd: cloneDir,
				timeout: 10_000,
				stdio: "pipe",
			});
			logger.debug({ commit, cloneDir }, "Checked out specific commit");
		} catch (e) {
			logger.debug(
				{ commit, error: e },
				"Could not checkout commit, staying on default branch",
			);
		}
	}

	return cloneDir;
}

/**
 * Run `git blame` on a specific line and extract the Session-Id
 * trailer from the authoring commit.
 *
 * Returns null if the file doesn't exist or blame fails.
 */
export function blameLineForSessionId(
	repoDir: string,
	file: string,
	line: number,
): BlameResult | null {
	try {
		const blameOutput = execFileSync(
			"git",
			["blame", "-L", `${line},${line}`, "--porcelain", file],
			{ cwd: repoDir, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
		).toString();

		const commitSha = blameOutput.split(" ")[0];
		if (!commitSha || commitSha.length < 7) return null;

		let sessionId: string | null = null;
		try {
			const trailer = execFileSync(
				"git",
				[
					"log",
					"-1",
					"--format=%(trailers:key=Session-Id,valueonly)",
					commitSha,
				],
				{ cwd: repoDir, timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] },
			)
				.toString()
				.trim();

			sessionId = trailer || null;
		} catch (e) {
			logger.debug(
				{ commitSha, error: e },
				"Could not extract Session-Id trailer",
			);
		}

		return { commitSha, sessionId };
	} catch (e) {
		logger.debug({ file, line, error: e }, "git blame failed");
		return null;
	}
}

/**
 * Remove a cloned repo directory.
 */
export function cleanupClone(cloneDir: string): void {
	try {
		fs.rmSync(cloneDir, { recursive: true, force: true });
		logger.debug({ cloneDir }, "Cleaned up cloned repo");
	} catch (e) {
		logger.debug({ cloneDir, error: e }, "Failed to clean up cloned repo");
	}
}
