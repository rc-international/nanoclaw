import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface LinuxUser {
	username: string;
	uid: number;
	gid: number;
	homeDir: string;
}

export interface UserSetupStatus {
	claudeAuth: boolean;
	ghCli: boolean;
	errors: string[];
}

const VALID_USERNAME = /^[a-z_][a-z0-9_-]*$/;

export function lookupLinuxUser(username: string): LinuxUser | null {
	if (!username || !VALID_USERNAME.test(username)) {
		return null;
	}

	try {
		const raw = execSync(`getent passwd ${username}`, { timeout: 5000 });
		const output = raw.toString("utf-8").trim();

		if (!output) return null;

		// Format: username:password:uid:gid:gecos:home:shell
		const parts = output.split(":");
		if (parts.length < 7) return null;

		return {
			username: parts[0],
			uid: parseInt(parts[2], 10),
			gid: parseInt(parts[3], 10),
			homeDir: parts[5],
		};
	} catch {
		return null;
	}
}

export function validateUserSetup(homeDir: string): UserSetupStatus {
	const errors: string[] = [];

	const claudeCredPath = path.join(homeDir, ".claude", ".credentials.json");
	const claudeAuth = fs.existsSync(claudeCredPath);
	if (!claudeAuth) {
		errors.push(`Claude credentials not found at ${claudeCredPath}`);
	}

	const ghHostsPath = path.join(homeDir, ".config", "gh", "hosts.yml");
	const ghCli = fs.existsSync(ghHostsPath);
	if (!ghCli) {
		errors.push(`GitHub CLI config not found at ${ghHostsPath}`);
	}

	return { claudeAuth, ghCli, errors };
}
