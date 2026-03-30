import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
	logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { HealDebouncer, validateHealPayload } from "./reactive-healer.js";
import type { HealBatch, HealRequest } from "./types.js";

describe("validateHealPayload", () => {
	const validPayload = {
		nanoclaw: "heal",
		user: "bjern",
		repo: "datarake",
		repo_url: "https://github.com/bjern/datarake",
		error: "Client error 400",
	};

	it("accepts a valid payload with required fields only", () => {
		const result = validateHealPayload(validPayload);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.request.user).toBe("bjern");
			expect(result.request.repo).toBe("datarake");
			expect(result.request.severity).toBe("error"); // default
		}
	});

	it("accepts a payload with all optional fields", () => {
		const full = {
			...validPayload,
			traceback: 'File "foo.py", line 10',
			file: "foo.py",
			line: 10,
			commit: "abc123",
			severity: "warning",
		};
		const result = validateHealPayload(full);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.request.file).toBe("foo.py");
			expect(result.request.line).toBe(10);
			expect(result.request.severity).toBe("warning");
		}
	});

	it('rejects when nanoclaw field is not "heal"', () => {
		const result = validateHealPayload({ ...validPayload, nanoclaw: "other" });
		expect(result.ok).toBe(false);
	});

	it("rejects when nanoclaw field is missing", () => {
		const { nanoclaw, ...rest } = validPayload;
		const result = validateHealPayload(rest);
		expect(result.ok).toBe(false);
	});

	it("rejects when required fields are missing", () => {
		for (const field of ["user", "repo", "repo_url", "error"]) {
			const partial = { ...validPayload };
			delete (partial as any)[field];
			const result = validateHealPayload(partial);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain(field);
			}
		}
	});

	it("rejects non-object input", () => {
		expect(validateHealPayload(null).ok).toBe(false);
		expect(validateHealPayload("string").ok).toBe(false);
		expect(validateHealPayload(42).ok).toBe(false);
	});

	it("coerces line to number", () => {
		const result = validateHealPayload({ ...validPayload, line: "305" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.request.line).toBe(305);
		}
	});
});

describe("HealDebouncer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const makeRequest = (overrides: Partial<HealRequest> = {}): HealRequest => ({
		nanoclaw: "heal",
		user: "bjern",
		repo: "datarake",
		repo_url: "https://github.com/bjern/datarake",
		error: "TestError",
		...overrides,
	});

	it("fires callback after debounce window", () => {
		const onBatch = vi.fn();
		const debouncer = new HealDebouncer(onBatch, 5000);

		debouncer.add(makeRequest({ file: "a.py", line: 10 }), "dc:123");
		expect(onBatch).not.toHaveBeenCalled();

		vi.advanceTimersByTime(5001);

		expect(onBatch).toHaveBeenCalledTimes(1);
		const batch: HealBatch = onBatch.mock.calls[0][0];
		expect(batch.user).toBe("bjern");
		expect(batch.repo).toBe("datarake");
		expect(batch.entries).toHaveLength(1);
		expect(batch.entries[0].file).toBe("a.py");
		expect(batch.entries[0].occurrences).toBe(1);

		debouncer.destroy();
	});

	it("resets timer on new error for same user+repo", () => {
		const onBatch = vi.fn();
		const debouncer = new HealDebouncer(onBatch, 5000);

		debouncer.add(
			makeRequest({ error: "Error1", file: "a.py", line: 1 }),
			"dc:123",
		);
		vi.advanceTimersByTime(3000);
		expect(onBatch).not.toHaveBeenCalled();

		debouncer.add(
			makeRequest({ error: "Error2", file: "b.py", line: 2 }),
			"dc:123",
		);
		vi.advanceTimersByTime(3000);
		expect(onBatch).not.toHaveBeenCalled();

		vi.advanceTimersByTime(2001);
		expect(onBatch).toHaveBeenCalledTimes(1);
		expect(onBatch.mock.calls[0][0].entries).toHaveLength(2);

		debouncer.destroy();
	});

	it("deduplicates same file+line+error", () => {
		const onBatch = vi.fn();
		const debouncer = new HealDebouncer(onBatch, 5000);

		const req = makeRequest({ error: "Same", file: "a.py", line: 10 });
		debouncer.add(req, "dc:123");
		debouncer.add(req, "dc:123");
		debouncer.add(req, "dc:123");

		vi.advanceTimersByTime(5001);

		expect(onBatch).toHaveBeenCalledTimes(1);
		const batch: HealBatch = onBatch.mock.calls[0][0];
		expect(batch.entries).toHaveLength(1);
		expect(batch.entries[0].occurrences).toBe(3);

		debouncer.destroy();
	});

	it("keeps separate timers for different user+repo", () => {
		const onBatch = vi.fn();
		const debouncer = new HealDebouncer(onBatch, 5000);

		debouncer.add(makeRequest({ user: "bjern", repo: "datarake" }), "dc:123");
		debouncer.add(makeRequest({ user: "alice", repo: "api" }), "dc:456");

		vi.advanceTimersByTime(5001);

		expect(onBatch).toHaveBeenCalledTimes(2);

		debouncer.destroy();
	});

	it("uses traceback to extract file+line when not provided", () => {
		const onBatch = vi.fn();
		const debouncer = new HealDebouncer(onBatch, 5000);

		debouncer.add(
			makeRequest({
				traceback: 'File "src/app.py", line 42, in main\n  crash()',
				file: undefined,
				line: undefined,
			}),
			"dc:123",
		);

		vi.advanceTimersByTime(5001);

		const batch: HealBatch = onBatch.mock.calls[0][0];
		expect(batch.entries[0].file).toBe("src/app.py");
		expect(batch.entries[0].line).toBe(42);

		debouncer.destroy();
	});
});
