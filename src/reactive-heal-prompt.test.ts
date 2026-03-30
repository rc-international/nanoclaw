import { describe, expect, it } from "vitest";

import { buildReactiveHealPrompt } from "./reactive-heal-prompt.js";
import type { HealBatch } from "./types.js";

describe("buildReactiveHealPrompt", () => {
	const batch: HealBatch = {
		user: "bjern",
		repo: "datarake",
		repo_url: "https://github.com/bjern/datarake",
		sourceChannelJid: "dc:123456",
		entries: [
			{
				file: "src/datarake/parqinglot.py",
				line: 305,
				error: "Client error '400 Bad Request'",
				traceback:
					'File "src/datarake/parqinglot.py", line 305\n  resp.raise_for_status()',
				commit: "a1b2c3d",
				occurrences: 12,
				blameCommit: "f4e5d6c",
				sessionId: "test-session-abc",
			},
			{
				file: "src/datarake/client.py",
				line: 42,
				error: "ConnectionTimeout",
				occurrences: 1,
			},
		],
	};

	it("includes all errors with details", () => {
		const prompt = buildReactiveHealPrompt(batch, "/workspace/repo");
		expect(prompt).toContain("ERROR 1 (12 occurrences)");
		expect(prompt).toContain("src/datarake/parqinglot.py:305");
		expect(prompt).toContain("Client error '400 Bad Request'");
		expect(prompt).toContain("ERROR 2 (1 occurrence)");
		expect(prompt).toContain("src/datarake/client.py:42");
		expect(prompt).toContain("ConnectionTimeout");
	});

	it("includes blame and session context when available", () => {
		const prompt = buildReactiveHealPrompt(batch, "/workspace/repo");
		expect(prompt).toContain("f4e5d6c");
		expect(prompt).toContain("test-session-abc");
	});

	it("includes repo path and workflow instructions", () => {
		const prompt = buildReactiveHealPrompt(batch, "/workspace/repo");
		expect(prompt).toContain("/workspace/repo");
		expect(prompt).toContain("send_message");
		expect(prompt).toContain("heal/");
	});

	it("handles entries without optional fields", () => {
		const minimal: HealBatch = {
			...batch,
			entries: [
				{
					file: "app.py",
					line: 1,
					error: "SomeError",
					occurrences: 1,
				},
			],
		};
		const prompt = buildReactiveHealPrompt(minimal, "/workspace/repo");
		expect(prompt).toContain("app.py:1");
		expect(prompt).not.toContain("undefined");
	});
});
