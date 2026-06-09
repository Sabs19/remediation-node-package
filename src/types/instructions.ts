import type { MaskStrategy, MatchType, WireKeyPattern, WireRuntimeInstructionPayload, WireRule } from './wireProtocol.js';
import type { Request } from 'express';

// ---------------------------------------------------------------------------
// MaskRule — parsed, strongly typed version of WireKeyPattern
// ---------------------------------------------------------------------------

export class MaskRule {
  constructor(
    public readonly ruleId:       string,
    public readonly key:          string,
    public readonly matchType:    MatchType,
    public readonly maskStrategy: MaskStrategy,
    public readonly pattern:      string | null,
    public readonly maskChar:     string,
    public readonly separator:    string,
  ) {}

  static fromWire(kp: WireKeyPattern, ruleId: string): MaskRule {
    return new MaskRule(
      ruleId,
      kp.key,
      kp.match_type,
      kp.mask_strategy,
      kp.pattern,
      kp.mask_char,
      kp.separator,
    );
  }

  matchesKey(key: string): boolean {
    if (this.matchType === 'exact') {
      return this.key === key;
    }
    if (this.matchType === 'regex' && this.pattern !== null) {
      try {
        return new RegExp(this.pattern).test(key);
      } catch {
        return false;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// RouteBlock — parsed from WireRouteBlockConfig
// ---------------------------------------------------------------------------

export interface RouteBlock {
  readonly blockedRoutes:   Array<{ method: string; path: string }>;
  readonly responseStatus:  number;
  readonly responseBody:    Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// RuntimeInstruction — parsed, validated, serialisable
// ---------------------------------------------------------------------------

export class RuntimeInstruction {
  constructor(
    public readonly instructionId:   string,
    public readonly instructionType: string,
    public readonly priority:        number,
    public readonly effectiveAt:     number,
    public readonly expiresAt:       number,
    public readonly includeRoutes:   string[],
    public readonly excludeRoutes:   string[],
    public readonly httpMethods:     string[],
    public readonly maskRules:       MaskRule[],
    public readonly routeBlocks:     RouteBlock[],
    public readonly injectHeaders:   Record<string, string>,
    public readonly rulesChecksum:   string,
  ) {}

  static fromWirePayload(payload: WireRuntimeInstructionPayload): RuntimeInstruction {
    const maskRules:    MaskRule[]   = [];
    const routeBlocks:  RouteBlock[] = [];
    let   injectHeaders: Record<string, string> = {};

    for (const rule of payload.rules) {
      RuntimeInstruction.extractRule(rule, maskRules, routeBlocks, (h) => {
        injectHeaders = { ...injectHeaders, ...h };
      });
    }

    return new RuntimeInstruction(
      payload.instruction_id,
      payload.instruction_type,
      payload.priority,
      payload.effective_at,
      payload.expires_at,
      payload.targets.routes.include,
      payload.targets.routes.exclude,
      payload.targets.http_methods,
      maskRules,
      routeBlocks,
      injectHeaders,
      payload.checksum,
    );
  }

  private static extractRule(
    rule: WireRule,
    maskRules:    MaskRule[],
    routeBlocks:  RouteBlock[],
    onHeaders:    (h: Record<string, string>) => void,
  ): void {
    const config = rule.config as Record<string, unknown>;

    switch (rule.rule_type) {
      case 'pii_mask': {
        const patterns = (config['key_patterns'] as WireKeyPattern[] | undefined) ?? [];
        for (const kp of patterns) {
          maskRules.push(MaskRule.fromWire(kp, rule.rule_id));
        }
        break;
      }
      case 'route_block': {
        routeBlocks.push({
          blockedRoutes:  (config['blocked_routes'] as Array<{ method: string; path: string }> | undefined) ?? [],
          responseStatus: (config['response_status'] as number | undefined) ?? 503,
          responseBody:   (config['response_body']   as Record<string, unknown> | undefined) ?? { error: 'Service temporarily unavailable.' },
        });
        break;
      }
      case 'header_inject': {
        onHeaders((config['headers'] as Record<string, string> | undefined) ?? {});
        break;
      }
    }
  }

  isExpired(): boolean {
    return Date.now() / 1000 > this.expiresAt;
  }

  isEffective(): boolean {
    const now = Date.now() / 1000;
    return now >= this.effectiveAt && !this.isExpired();
  }

  toJSON(): Record<string, unknown> {
    return {
      instruction_id:   this.instructionId,
      instruction_type: this.instructionType,
      priority:         this.priority,
      effective_at:     this.effectiveAt,
      expires_at:       this.expiresAt,
      include_routes:   this.includeRoutes,
      exclude_routes:   this.excludeRoutes,
      http_methods:     this.httpMethods,
      mask_rules:       this.maskRules.map((r) => ({
        rule_id:       r.ruleId,
        key:           r.key,
        match_type:    r.matchType,
        mask_strategy: r.maskStrategy,
        pattern:       r.pattern,
        mask_char:     r.maskChar,
        separator:     r.separator,
      })),
      route_blocks:    this.routeBlocks,
      inject_headers:  this.injectHeaders,
      checksum:        this.rulesChecksum,
    };
  }

  static fromJSON(raw: Record<string, unknown>): RuntimeInstruction {
    const maskRules = ((raw['mask_rules'] as unknown[] | undefined) ?? []).map((r) => {
      const m = r as Record<string, unknown>;
      return new MaskRule(
        String(m['rule_id']       ?? ''),
        String(m['key']           ?? ''),
        (m['match_type']          ?? 'exact')    as MatchType,
        (m['mask_strategy']       ?? 'full_redact') as MaskStrategy,
        m['pattern'] != null ? String(m['pattern']) : null,
        String(m['mask_char']     ?? 'X'),
        String(m['separator']     ?? '-'),
      );
    });

    return new RuntimeInstruction(
      String(raw['instruction_id']   ?? ''),
      String(raw['instruction_type'] ?? ''),
      Number(raw['priority']         ?? 100),
      Number(raw['effective_at']     ?? 0),
      Number(raw['expires_at']       ?? 0),
      (raw['include_routes'] as string[] | undefined) ?? ['*'],
      (raw['exclude_routes'] as string[] | undefined) ?? [],
      (raw['http_methods']   as string[] | undefined) ?? [],
      maskRules,
      (raw['route_blocks']   as RouteBlock[] | undefined) ?? [],
      (raw['inject_headers'] as Record<string, string> | undefined) ?? {},
      String(raw['checksum'] ?? ''),
    );
  }
}

// ---------------------------------------------------------------------------
// InstructionCollection — the aggregate queried by the middleware on every request
// ---------------------------------------------------------------------------

export class InstructionCollection {
  constructor(private readonly instructions: RuntimeInstruction[]) {}

  static empty(): InstructionCollection {
    return new InstructionCollection([]);
  }

  isEmpty(): boolean {
    return this.instructions.length === 0;
  }

  maskRules(): MaskRule[] {
    return this.sortedByPriority().flatMap((i) => i.maskRules);
  }

  hasMaskRules(): boolean {
    return this.maskRules().length > 0;
  }

  /** Merged headers; lower priority number wins on key conflict. */
  injectHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const instruction of this.sortedByPriority()) {
      Object.assign(headers, instruction.injectHeaders);
    }
    return headers;
  }

  /** First matching route-block config, or null. */
  matchingRouteBlock(req: Request): RouteBlock | null {
    for (const instruction of this.sortedByPriority()) {
      for (const block of instruction.routeBlocks) {
        for (const route of block.blockedRoutes) {
          if (this.routeMatches(req, route.method, route.path)) {
            return block;
          }
        }
      }
    }
    return null;
  }

  private sortedByPriority(): RuntimeInstruction[] {
    return [...this.instructions].sort((a, b) => a.priority - b.priority);
  }

  private routeMatches(req: Request, method: string, pattern: string): boolean {
    if (req.method.toUpperCase() !== method.toUpperCase()) return false;
    // Simple glob-style matching via regex conversion
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${regexStr}$`).test(req.path.replace(/^\//, ''));
  }
}
