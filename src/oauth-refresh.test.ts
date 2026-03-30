import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
	logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock("child_process", () => ({
	execFile: vi.fn(),
}));

import {
	credentialsPath,
	ensureFreshToken,
	readTokenState,
} from "./oauth-refresh.js";

const TEST_HOME = "/tmp/oauth-refresh-test-" + process.pid;
const CREDS_DIR = path.join(TEST_HOME, ".claude");
const CREDS_PATH = path.join(CREDS_DIR, ".credentials.json");

const mockExecFile = vi.mocked(execFile);

function writeCreds(overrides: Record<string, unknown> = {}): void {
	const creds = {
		claudeAiOauth: {
			accessToken: "sk-ant-oat01-test-access",
			refreshToken: "sk-ant-ort01-test-refresh",
			expiresAt: Date.now() + 8 * 60 * 60 * 1000, // 8h from now
			scopes: ["user:inference"],
			subscriptionType: "max",
			...overrides,
		},
	};
	fs.mkdirSync(CREDS_DIR, { recursive: true });
	fs.writeFileSync(CREDS_PATH, JSON.stringify(creds));
}

beforeEach(() => {
	fs.mkdirSync(CREDS_DIR, { recursive: true });
	mockExecFile.mockReset();
});

afterEach(() => {
	fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("credentialsPath", () => {
	it("uses provided home directory", () => {
		expect(credentialsPath("/custom/home")).toBe(
			"/custom/home/.claude/.credentials.json",
		);
	});
});

describe("readTokenState", () => {
	it("returns token state from valid credentials", () => {
		writeCreds();
		const state = readTokenState(TEST_HOME);
		expect(state).not.toBeNull();
		expect(state!.accessToken).toBe("sk-ant-oat01-test-access");
		expect(state!.refreshToken).toBe("sk-ant-ort01-test-refresh");
		expect(state!.expiresAt).toBeGreaterThan(Date.now());
	});

	it("returns null when file does not exist", () => {
		expect(readTokenState(TEST_HOME)).toBeNull();
	});

	it("returns null when credentials are malformed", () => {
		fs.writeFileSync(CREDS_PATH, '{"claudeAiOauth": {}}');
		expect(readTokenState(TEST_HOME)).toBeNull();
	});
});

describe("ensureFreshToken", () => {
	it("is a no-op when token is fresh", async () => {
		writeCreds({ expiresAt: Date.now() + 60 * 60 * 1000 }); // 1h out
		const result = await ensureFreshToken(TEST_HOME);
		expect(result.refreshed).toBe(false);
		expect(result.error).toBeUndefined();
		// Should not have called the CLI
		expect(mockExecFile).not.toHaveBeenCalled();
	});

	it("returns error when credentials file is missing", async () => {
		const result = await ensureFreshToken(TEST_HOME);
		expect(result.refreshed).toBe(false);
		expect(result.error).toContain("Cannot read credentials");
	});

	it("returns error when no refresh token", async () => {
		writeCreds({ refreshToken: undefined });
		const result = await ensureFreshToken(TEST_HOME);
		expect(result.refreshed).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it("calls claude CLI and reports success when token is updated", async () => {
		const nearExpiry = Date.now() + 60 * 1000; // 1 min — within buffer
		writeCreds({ expiresAt: nearExpiry });

		// Mock execFile to simulate CLI refreshing the token
		mockExecFile.mockImplementation(
			(_cmd: any, _args: any, _opts: any, cb: any) => {
				// Simulate the CLI updating the credentials file
				writeCreds({ expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
				cb(null, '{"loggedIn": true}', "");
				return { unref: vi.fn() } as any;
			},
		);

		const result = await ensureFreshToken(TEST_HOME, 5 * 60 * 1000);
		expect(result.refreshed).toBe(true);
		expect(result.error).toBeUndefined();
		expect(mockExecFile).toHaveBeenCalledWith(
			"claude",
			["-p", "ok", "--max-turns", "1"],
			expect.objectContaining({ timeout: 30_000 }),
			expect.any(Function),
		);
	});

	it("reports error when CLI fails", async () => {
		writeCreds({ expiresAt: Date.now() + 60 * 1000 });

		mockExecFile.mockImplementation(
			(_cmd: any, _args: any, _opts: any, cb: any) => {
				cb(new Error("command not found"), "", "claude: not found");
				return { unref: vi.fn() } as any;
			},
		);

		const result = await ensureFreshToken(TEST_HOME, 5 * 60 * 1000);
		expect(result.refreshed).toBe(false);
		expect(result.error).toContain("CLI token refresh failed");
	});

	it("handles concurrent calls with deduplication", async () => {
		writeCreds({ expiresAt: Date.now() + 60 * 1000 }); // near-expiry

		mockExecFile.mockImplementation(
			(_cmd: any, _args: any, _opts: any, cb: any) => {
				writeCreds({ expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
				cb(null, "{}", "");
				return { unref: vi.fn() } as any;
			},
		);

		const [r1, r2] = await Promise.all([
			ensureFreshToken(TEST_HOME),
			ensureFreshToken(TEST_HOME),
		]);

		// Both should return the same result (deduplicated)
		expect(r1.refreshed).toBe(r2.refreshed);
		// Should only have spawned one CLI process
		expect(mockExecFile).toHaveBeenCalledTimes(1);
	});
});
