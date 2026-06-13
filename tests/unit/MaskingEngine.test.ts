import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MaskingEngine } from '../../src/services/MaskingEngine.js';
import { MaskRule } from '../../src/types/instructions.js';
import type { MaskStrategy } from '../../src/types/wireProtocol.js';

const engine = new MaskingEngine();

function rule(key: string, strategy: string, matchType: 'exact' | 'regex' = 'exact'): MaskRule {
  return new MaskRule(
    'test-rule',                              // ruleId
    key,                                      // key
    matchType,                                // matchType
    strategy as MaskStrategy,
    matchType === 'regex' ? key : null,       // pattern
    '*',                                      // maskChar
    '',                                       // separator
  );
}

describe('MaskingEngine', () => {

  describe('partial_last4', () => {
    it('masks all but last four chars', () => {
      const result = engine.apply({ card: '4111111111111234' }, [rule('card', 'partial_last4')]);
      assert.equal((result as Record<string, string>)['card'], 'XXXX-XXXX-XXXX-1234');
    });

    it('passes short value through unchanged', () => {
      const result = engine.apply({ card: '123' }, [rule('card', 'partial_last4')]);
      assert.equal((result as Record<string, string>)['card'], '123');
    });
  });

  describe('email_domain_only', () => {
    it('preserves domain, masks local part', () => {
      const result = engine.apply({ email: 'user@example.com' }, [rule('email', 'email_domain_only')]);
      assert.equal((result as Record<string, string>)['email'], '****@example.com');
    });

    it('falls back to REDACTED for non-email', () => {
      const result = engine.apply({ email: 'not-an-email' }, [rule('email', 'email_domain_only')]);
      assert.equal((result as Record<string, string>)['email'], '[REDACTED]');
    });
  });

  describe('last4_only', () => {
    it('shows only last four characters', () => {
      const result = engine.apply({ phone: '5551234567' }, [rule('phone', 'last4_only')]);
      assert.equal((result as Record<string, string>)['phone'], '****4567');
    });
  });

  describe('full_redact', () => {
    it('replaces value with [REDACTED]', () => {
      const result = engine.apply({ ssn: '123-45-6789' }, [rule('ssn', 'full_redact')]);
      assert.equal((result as Record<string, string>)['ssn'], '[REDACTED]');
    });
  });

  describe('hash_stable', () => {
    it('produces deterministic 16-char hex', () => {
      const a = engine.apply({ uid: 'abc' }, [rule('uid', 'hash_stable')]) as Record<string, string>;
      const b = engine.apply({ uid: 'abc' }, [rule('uid', 'hash_stable')]) as Record<string, string>;
      assert.equal(a['uid'], b['uid']);
      assert.match(a['uid']!, /^[0-9a-f]{16}$/);
    });

    it('differs for different input values', () => {
      const a = engine.apply({ uid: 'alice' }, [rule('uid', 'hash_stable')]) as Record<string, string>;
      const b = engine.apply({ uid: 'bob' },   [rule('uid', 'hash_stable')]) as Record<string, string>;
      assert.notEqual(a['uid'], b['uid']);
    });
  });

  describe('deep traversal', () => {
    it('masks nested key without mutating original', () => {
      const original = { user: { email: 'a@b.com', name: 'Alice' } };
      const result   = engine.apply(original, [rule('email', 'full_redact')]) as typeof original;

      assert.equal(result.user.email, '[REDACTED]');
      assert.equal(result.user.name,  'Alice');
      assert.equal(original.user.email, 'a@b.com'); // original untouched
    });

    it('masks values inside arrays', () => {
      const data   = { contacts: [{ email: 'a@b.com' }, { email: 'c@d.com' }] };
      const result = engine.apply(data, [rule('email', 'full_redact')]) as typeof data;

      assert.equal(result.contacts[0]?.email, '[REDACTED]');
      assert.equal(result.contacts[1]?.email, '[REDACTED]');
    });

    it('does not throw on deeply nested input beyond MAX_DEPTH', () => {
      // Build a 25-level deep object.
      const buildDeep = (depth: number): Record<string, unknown> =>
        depth === 0 ? { secret: 'hidden' } : { child: buildDeep(depth - 1) };

      const deep = buildDeep(25);
      // Should not throw — stops at depth limit.
      assert.doesNotThrow(() => engine.apply(deep, [rule('secret', 'full_redact')]));
    });
  });

  describe('regex match_type', () => {
    it('masks key matching regex pattern', () => {
      const data   = { credit_card: '4111111111111234', name: 'Bob' };
      const result = engine.apply(data, [rule('/^credit_/', 'partial_last4', 'regex')]) as typeof data;

      assert.match(result.credit_card, /1234$/);
      assert.equal(result.name, 'Bob');
    });
  });

});
