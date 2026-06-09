import type { MaskRule } from '../types/instructions.js';
import { createHash } from 'crypto';

/**
 * Pure stateless masking engine — no I/O, no Redis, no logging.
 * Byte-for-byte logic equivalent of the PHP MaskingEngine.
 *
 * Applies PII masking rules via deep recursive traversal of an arbitrary
 * data structure. All mutations happen on a deep clone (JSON round-trip);
 * the original is never touched until the full masked copy is ready.
 *
 * Supported strategies:
 *   partial_last4      — keeps last 4 digits, masks the rest (phone numbers)
 *   email_domain_only  — masks local part, keeps @domain
 *   last4_only         — keeps last 4 digits only (credit cards)
 *   full_redact        — replaces value with '[REDACTED]'
 *   hash_stable        — deterministic SHA-256 truncated to 16 hex chars
 */
export class MaskingEngine {
  private static readonly MAX_DEPTH = 20;

  apply(data: unknown, rules: MaskRule[]): unknown {
    if (rules.length === 0) return data;

    // Deep clone via JSON round-trip — matches PHP behaviour exactly.
    const clone: unknown = JSON.parse(JSON.stringify(data));
    return this.traverse(clone, rules, 0);
  }

  private traverse(data: unknown, rules: MaskRule[], depth: number): unknown {
    if (depth > MaskingEngine.MAX_DEPTH) return data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      // Arrays: recurse into elements without key matching.
      if (Array.isArray(data)) {
        return (data as unknown[]).map((item) => this.traverse(item, rules, depth + 1));
      }
      return data;
    }

    const obj = data as Record<string, unknown>;

    for (const key of Object.keys(obj)) {
      const value       = obj[key];
      const matchedRule = this.findMatchingRule(key, rules);

      if (matchedRule !== null && value !== null && typeof value !== 'object') {
        obj[key] = this.maskValue(String(value), matchedRule);
      } else if (typeof value === 'object' && value !== null) {
        obj[key] = this.traverse(value, rules, depth + 1);
      }
    }

    return obj;
  }

  private findMatchingRule(key: string, rules: MaskRule[]): MaskRule | null {
    for (const rule of rules) {
      if (rule.matchesKey(key)) return rule;
    }
    return null;
  }

  private maskValue(value: string, rule: MaskRule): string {
    switch (rule.maskStrategy) {
      case 'partial_last4':     return this.maskPartialLast4(value, rule.maskChar, rule.separator);
      case 'email_domain_only': return this.maskEmailDomainOnly(value);
      case 'last4_only':        return this.maskLast4Only(value, rule.maskChar);
      case 'full_redact':       return '[REDACTED]';
      case 'hash_stable':       return createHash('sha256').update(value).digest('hex').slice(0, 16);
      default:                  return '[REDACTED]';
    }
  }

  private maskPartialLast4(value: string, maskChar: string, separator: string): string {
    const digits = value.replace(/\D/g, '');
    const last4  = digits.length >= 4 ? digits.slice(-4) : digits.padStart(4, maskChar);
    return `${maskChar.repeat(4)}${separator}${maskChar.repeat(4)}${separator}${last4}`;
  }

  private maskEmailDomainOnly(value: string): string {
    const atIndex = value.indexOf('@');
    if (atIndex === -1) return '****';
    return `****${value.slice(atIndex)}`;
  }

  private maskLast4Only(value: string, maskChar: string): string {
    const digits = value.replace(/\D/g, '');
    if (digits.length <= 4) return digits;
    return maskChar.repeat(digits.length - 4) + digits.slice(-4);
  }
}
