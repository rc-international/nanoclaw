import { describe, expect, it, vi } from "vitest";
import { lookupLinuxUser, validateUserSetup } from "./user-profile.js";

// Mock child_process for /etc/passwd lookup
vi.mock("child_process", () => ({
	execSync: vi.fn((cmd: string) => {
		if (cmd.includes("getent passwd alice")) {
			return Buffer.from("alice:x:1001:1001:Alice:/home/alice:/bin/bash\n");
		}
		if (cmd.includes("getent passwd nobody")) {
			throw new Error("exit code 2");
		}
		return Buffer.from("");
	}),
}));

// Mock fs for credential checks
vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs");
	return {
		...actual,
		default: {
			...actual,
			existsSync: vi.fn((filePath: string) => {
				if (String(filePath) === "/home/alice/.claude/.credentials.json")
					return true;
				if (String(filePath) === "/home/alice/.config/gh/hosts.yml")
					return true;
				return actual.existsSync(filePath);
			}),
		},
	};
});

describe("lookupLinuxUser", () => {
	it("parses /etc/passwd entry for valid user", () => {
		const result = lookupLinuxUser("alice");
		expect(result).toEqual({
			username: "alice",
			uid: 1001,
			gid: 1001,
			homeDir: "/home/alice",
		});
	});

	it("returns null for nonexistent user", () => {
		const result = lookupLinuxUser("nobody");
		expect(result).toBeNull();
	});

	it("rejects invalid username characters", () => {
		expect(lookupLinuxUser("alice;rm -rf")).toBeNull();
		expect(lookupLinuxUser("../etc")).toBeNull();
		expect(lookupLinuxUser("")).toBeNull();
	});
});

describe("validateUserSetup", () => {
	it("returns ok when Claude and gh credentials exist", () => {
		const result = validateUserSetup("/home/alice");
		expect(result.claudeAuth).toBe(true);
		expect(result.ghCli).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});
