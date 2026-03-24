/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 *
 * Uses `claude` CLI in print mode (`-p`) instead of the Agent SDK.
 * This authenticates via the user's Claude Max subscription directly,
 * avoiding the OAuth token exchange that Anthropic blocks for third-party use.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per query in the message loop).
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ClaudeJsonOutput {
  type: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  is_error?: boolean;
  duration_ms?: number;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Build the MCP config JSON for the nanoclaw IPC server.
 */
function buildMcpConfig(mcpServerPath: string, containerInput: ContainerInput): string {
  const config = {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
    },
  };
  return JSON.stringify(config);
}

/**
 * Discover additional directories mounted at /workspace/extra/*
 */
function discoverExtraDirs(): string[] {
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  return extraDirs;
}

/**
 * Load global CLAUDE.md content for non-main groups.
 */
function loadGlobalClaudeMd(isMain: boolean): string | null {
  if (isMain) return null;
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (fs.existsSync(globalClaudeMdPath)) {
    return fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }
  return null;
}

/**
 * Run a single query via `claude -p` CLI.
 * Returns the parsed result and session ID.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
): Promise<{ result: string | null; newSessionId?: string; closedDuringQuery: boolean }> {

  const args: string[] = [
    '-p',                                    // Print mode (non-interactive)
    '--output-format', 'json',               // JSON output with session_id
    '--dangerously-skip-permissions',         // No permission prompts in container
    '--setting-sources', 'project,user',     // Load project + user settings
  ];

  // Session resume
  if (sessionId) {
    args.push('--resume', sessionId);
  }

  // MCP config for nanoclaw IPC tools
  args.push('--mcp-config', buildMcpConfig(mcpServerPath, containerInput));

  // Additional directories
  const extraDirs = discoverExtraDirs();
  for (const dir of extraDirs) {
    args.push('--add-dir', dir);
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Global CLAUDE.md as appended system prompt
  const globalClaudeMd = loadGlobalClaudeMd(containerInput.isMain);
  if (globalClaudeMd) {
    args.push('--append-system-prompt', globalClaudeMd);
  }

  // Allowed tools
  args.push('--allowedTools',
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    'Task', 'TaskOutput', 'TaskStop',
    'TeamCreate', 'TeamDelete', 'SendMessage',
    'TodoWrite', 'ToolSearch', 'Skill',
    'NotebookEdit',
    'mcp__nanoclaw__*',
  );

  // Prompt is piped via stdin to avoid argument length limits and shell metacharacter issues
  log(`Starting claude CLI (session: ${sessionId || 'new'}, prompt: ${prompt.length} chars)...`);

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', args, {
      cwd: '/workspace/group',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Feed prompt via stdin
    claude.stdin.write(prompt);
    claude.stdin.end();

    let stdout = '';
    let stderr = '';
    let closedDuringQuery = false;

    // Poll for IPC close sentinel during query
    let ipcPolling = true;
    const pollClose = () => {
      if (!ipcPolling) return;
      if (shouldClose()) {
        log('Close sentinel detected during query, killing claude process');
        closedDuringQuery = true;
        claude.kill('SIGTERM');
        ipcPolling = false;
        return;
      }
      // Also drain and log any follow-up messages (they'll be picked up in the next query)
      const messages = drainIpcInput();
      for (const text of messages) {
        log(`IPC message received during query (${text.length} chars) — will process after current query`);
      }
      setTimeout(pollClose, IPC_POLL_MS);
    };
    setTimeout(pollClose, IPC_POLL_MS);

    claude.stdout.on('data', (data) => { stdout += data.toString(); });
    claude.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      // Log stderr lines for debugging
      for (const line of chunk.trim().split('\n')) {
        if (line) log(`[claude] ${line}`);
      }
    });

    claude.on('close', (code) => {
      ipcPolling = false;

      if (closedDuringQuery) {
        resolve({ result: null, newSessionId: sessionId, closedDuringQuery: true });
        return;
      }

      // Parse JSON output
      try {
        const parsed: ClaudeJsonOutput = JSON.parse(stdout);
        const newSessionId = parsed.session_id || sessionId;

        if (parsed.is_error || parsed.subtype === 'error_response') {
          log(`Claude CLI error: ${parsed.result || 'unknown error'}`);
          resolve({
            result: parsed.result || null,
            newSessionId,
            closedDuringQuery: false,
          });
        } else {
          log(`Claude CLI completed (${parsed.duration_ms}ms)`);
          resolve({
            result: parsed.result || null,
            newSessionId,
            closedDuringQuery: false,
          });
        }
      } catch {
        // If JSON parse fails, use raw stdout as result
        if (code === 0 && stdout.trim()) {
          log('Claude CLI returned non-JSON output, using as raw text');
          resolve({ result: stdout.trim(), newSessionId: sessionId, closedDuringQuery: false });
        } else {
          const errorMsg = `Claude CLI exited with code ${code}: ${stderr.slice(-500)}`;
          log(errorMsg);
          reject(new Error(errorMsg));
        }
      }
    });

    claude.on('error', (err) => {
      ipcPolling = false;
      reject(err);
    });

  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  try {
    while (true) {
      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput);

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      // Emit output so host can stream it to the user
      writeOutput({
        status: 'success',
        result: queryResult.result,
        newSessionId: sessionId,
      });

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
