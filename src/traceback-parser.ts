export interface TraceFrame {
  file: string;
  line: number;
}

// Python: File "path/to/file.py", line 42, in function_name
const PYTHON_FRAME = /File "([^"]+)", line (\d+)/g;

// Node.js: at functionName (/path/to/file.ts:42:18)
// Also matches: at /path/to/file.ts:42:18
const NODE_FRAME = /at\s+(?:\S+\s+)?\(?((?:\/|[a-zA-Z]:)[^:)]+):(\d+):\d+\)?/g;

/**
 * Extract file+line pairs from a stack trace string.
 * Supports Python and Node.js formats. Filters out internal
 * node: modules. Returns frames in source order.
 */
export function parseTraceback(text: string): TraceFrame[] {
  const frames: TraceFrame[] = [];
  const seen = new Set<string>();

  // Python frames
  for (const match of text.matchAll(PYTHON_FRAME)) {
    const key = `${match[1]}:${match[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      frames.push({ file: match[1], line: parseInt(match[2], 10) });
    }
  }

  // Node.js frames (skip node: built-in modules)
  for (const match of text.matchAll(NODE_FRAME)) {
    if (match[1].startsWith('node:')) continue;
    const key = `${match[1]}:${match[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      frames.push({ file: match[1], line: parseInt(match[2], 10) });
    }
  }

  return frames;
}
