import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkTrigger } from './index.js';
import type { NewMessage } from './types.js';

// Mock the logger to capture log output
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Import logger after mock so we get the mocked version
const { logger } = await import('./logger.js');

function makeMessage(
  content: string,
  overrides?: Partial<NewMessage>,
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'dc:test-channel',
    sender: 'user-123',
    sender_name: 'TestUser',
    content,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const SANDMAN_TRIGGER = /^@Sandman\b/i;
const DEFAULT_ALLOWLIST = {
  default: { allow: '*' as const, mode: 'trigger' as const },
  chats: {},
  logDenied: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkTrigger', () => {
  describe('correct trigger — must process', () => {
    it('processes message with exact trigger name', () => {
      const messages = [makeMessage('@Sandman check the logs')];
      const result = checkTrigger(
        messages,
        'dc:test',
        'test-group',
        SANDMAN_TRIGGER,
        DEFAULT_ALLOWLIST,
      );
      expect(result.shouldProcess).toBe(true);
    });

    it('processes trigger case-insensitively', () => {
      const messages = [makeMessage('@sandman check the logs')];
      const result = checkTrigger(
        messages,
        'dc:test',
        'test-group',
        SANDMAN_TRIGGER,
        DEFAULT_ALLOWLIST,
      );
      expect(result.shouldProcess).toBe(true);
    });

    it('processes when trigger is in a batch of messages', () => {
      const messages = [
        makeMessage('hello'),
        makeMessage('some context'),
        makeMessage('@Sandman monitor parqinglot'),
      ];
      const result = checkTrigger(
        messages,
        'dc:test',
        'test-group',
        SANDMAN_TRIGGER,
        DEFAULT_ALLOWLIST,
      );
      expect(result.shouldProcess).toBe(true);
    });

    it('processes trigger from is_from_me regardless of allowlist', () => {
      const messages = [makeMessage('@Sandman do this', { is_from_me: true })];
      const restrictiveAllowlist = {
        default: { allow: [] as string[], mode: 'trigger' as const },
        chats: {},
        logDenied: true,
      };
      const result = checkTrigger(
        messages,
        'dc:test',
        'test-group',
        SANDMAN_TRIGGER,
        restrictiveAllowlist,
      );
      expect(result.shouldProcess).toBe(true);
    });
  });

  describe('wrong trigger name — must NOT silently drop', () => {
    it('rejects and warns when message uses wrong bot name', () => {
      const messages = [makeMessage('@Andy check the logs')];
      const result = checkTrigger(
        messages,
        'dc:test',
        'test-group',
        SANDMAN_TRIGGER,
        DEFAULT_ALLOWLIST,
      );
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('wrong_mention:@Andy');
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          attempted: '@Andy',
          sender: 'user-123',
        }),
        expect.stringContaining('@Andy'),
      );
    });

    it('warns on any misdirected @mention', () => {
      const messages = [makeMessage('@WrongBot please help')];
      const result = checkTrigger(
        messages,
        'dc:test',
        'test-group',
        SANDMAN_TRIGGER,
        DEFAULT_ALLOWLIST,
      );
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('wrong_mention:@WrongBot');
      expect(logger.warn).toHaveBeenCalledOnce();
    });
  });

  describe('no trigger at all — must log', () => {
    it('rejects and logs debug when no @mention present', () => {
      const messages = [makeMessage('just a regular message')];
      const result = checkTrigger(
        messages,
        'dc:test',
        'test-group',
        SANDMAN_TRIGGER,
        DEFAULT_ALLOWLIST,
      );
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('no_trigger');
      expect(logger.debug).toHaveBeenCalledOnce();
    });

    it('rejects multiple messages with no trigger', () => {
      const messages = [
        makeMessage('hey everyone'),
        makeMessage('what is happening'),
        makeMessage('anyone here?'),
      ];
      const result = checkTrigger(
        messages,
        'dc:test',
        'test-group',
        SANDMAN_TRIGGER,
        DEFAULT_ALLOWLIST,
      );
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('no_trigger');
    });
  });

  describe('regression: NEVER a silent drop with zero logging', () => {
    it('always produces a log line when not processing', () => {
      const scenarios = [
        makeMessage('hello'),
        makeMessage('@WrongName do stuff'),
        makeMessage('@Andy do stuff'),
        makeMessage('no mention at all'),
        makeMessage('@OtherBot help me'),
      ];

      for (const msg of scenarios) {
        vi.clearAllMocks();
        const result = checkTrigger(
          [msg],
          'dc:test',
          'test-group',
          SANDMAN_TRIGGER,
          DEFAULT_ALLOWLIST,
        );

        if (!result.shouldProcess) {
          const totalLogCalls =
            (logger.warn as ReturnType<typeof vi.fn>).mock.calls.length +
            (logger.debug as ReturnType<typeof vi.fn>).mock.calls.length;
          expect(totalLogCalls).toBeGreaterThan(0);
        }
      }
    });

    it('returns a reason string for every rejection', () => {
      const scenarios = [
        makeMessage('no mention'),
        makeMessage('@WrongBot help'),
        makeMessage('plain text'),
      ];

      for (const msg of scenarios) {
        const result = checkTrigger(
          [msg],
          'dc:test',
          'test-group',
          SANDMAN_TRIGGER,
          DEFAULT_ALLOWLIST,
        );
        expect(result.shouldProcess).toBe(false);
        expect(result.reason).toBeDefined();
        expect(result.reason!.length).toBeGreaterThan(0);
      }
    });
  });

  describe('the original failing scenario', () => {
    it('rejects @Sandman message when trigger is @Andy (the bug)', () => {
      const andyTrigger = /^@Andy\b/i;
      const messages = [
        makeMessage(
          '@Sandman I want you to monitor the logs from parqinglot repo on bonsai vps',
        ),
      ];
      const result = checkTrigger(
        messages,
        'dc:discord-channel-123',
        'discord_main',
        andyTrigger,
        DEFAULT_ALLOWLIST,
      );
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('wrong_mention:@Sandman');
      // Must warn — this is the exact scenario that was silently dropped
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it('processes @Sandman message when trigger is @Sandman (the fix)', () => {
      const messages = [
        makeMessage(
          '@Sandman I want you to monitor the logs from parqinglot repo on bonsai vps',
        ),
      ];
      const result = checkTrigger(
        messages,
        'dc:discord-channel-123',
        'discord_main',
        SANDMAN_TRIGGER,
        DEFAULT_ALLOWLIST,
      );
      expect(result.shouldProcess).toBe(true);
    });
  });

  describe('nonsensical messages — must still reach the agent', () => {
    it('processes gibberish when correctly addressed', () => {
      const messages = [makeMessage('@Sandman asdf jkl qwerty')];
      const result = checkTrigger(
        messages,
        'dc:test',
        'test-group',
        SANDMAN_TRIGGER,
        DEFAULT_ALLOWLIST,
      );
      expect(result.shouldProcess).toBe(true);
    });

    it('processes empty-ish message when correctly addressed', () => {
      const messages = [makeMessage('@Sandman')];
      const result = checkTrigger(
        messages,
        'dc:test',
        'test-group',
        SANDMAN_TRIGGER,
        DEFAULT_ALLOWLIST,
      );
      expect(result.shouldProcess).toBe(true);
    });

    it('processes help request when correctly addressed', () => {
      const messages = [makeMessage('@Sandman help')];
      const result = checkTrigger(
        messages,
        'dc:test',
        'test-group',
        SANDMAN_TRIGGER,
        DEFAULT_ALLOWLIST,
      );
      expect(result.shouldProcess).toBe(true);
    });
  });
});
