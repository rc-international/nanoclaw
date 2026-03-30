import { describe, expect, it } from 'vitest';

import { parseTraceback } from './traceback-parser.js';

describe('parseTraceback', () => {
  it('parses Python traceback', () => {
    const tb = `Traceback (most recent call last):
  File "src/datarake/parqinglot.py", line 305, in insert_scrape_failure
    resp.raise_for_status()
  File "src/datarake/client.py", line 42, in send
    return self.session.post(url, data=data)
httpx.HTTPStatusError: Client error '400 Bad Request'`;

    const results = parseTraceback(tb);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]).toEqual({
      file: 'src/datarake/parqinglot.py',
      line: 305,
    });
    expect(results[1]).toEqual({
      file: 'src/datarake/client.py',
      line: 42,
    });
  });

  it('parses Node.js stack trace', () => {
    const tb = `Error: ENOENT: no such file or directory
    at Object.openSync (node:fs:603:3)
    at readFileSync (node:fs:471:35)
    at loadConfig (/app/src/config.ts:25:18)
    at main (/app/src/index.ts:100:5)`;

    const results = parseTraceback(tb);
    expect(results).toEqual([
      { file: '/app/src/config.ts', line: 25 },
      { file: '/app/src/index.ts', line: 100 },
    ]);
  });

  it('parses single-line Python frame', () => {
    const results = parseTraceback('File "src/app.py", line 10, in main');
    expect(results).toEqual([{ file: 'src/app.py', line: 10 }]);
  });

  it('returns empty array for non-traceback text', () => {
    expect(parseTraceback('just an error message')).toEqual([]);
    expect(parseTraceback('')).toEqual([]);
  });

  it('handles mixed formats', () => {
    const tb = `File "handler.py", line 5, in run
    at process (/srv/worker.js:88:12)`;
    const results = parseTraceback(tb);
    expect(results).toContainEqual({ file: 'handler.py', line: 5 });
    expect(results).toContainEqual({ file: '/srv/worker.js', line: 88 });
  });
});
