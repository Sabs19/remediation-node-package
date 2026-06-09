/**
 * Strict types for every object that crosses the SaaS <-> Agent wire boundary.
 * These mirror the JSON wire protocol defined in ARCHITECTURE_PLAN.md §3.
 * No optional fields — every absent value must be explicitly typed as | null.
 */

export type MessageType =
  | 'handshake'
  | 'runtime_instruction'
  | 'extraction_request'
  | 'extraction_response';

export type MaskStrategy =
  | 'partial_last4'
  | 'email_domain_only'
  | 'last4_only'
  | 'full_redact'
  | 'hash_stable';

export type MatchType = 'exact' | 'regex';

export type RuleType = 'pii_mask' | 'route_block' | 'header_inject' | 'circuit_breaker_test';

// ---------------------------------------------------------------------------
// Envelope (outer signed wrapper for every SaaS → Agent message)
// ---------------------------------------------------------------------------

export interface WireEnvelope {
  readonly protocol_version: string;
  readonly message_id:       string;
  readonly message_type:     MessageType;
  readonly client_id:        string;
  readonly issued_at:        number;
  readonly nonce:            string;
  readonly hmac_sha256:      string;
  readonly payload:          WireRuntimeInstructionPayload | WireExtractionRequestPayload | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// RuntimeInstruction payload (Mode B — in-memory interception)
// ---------------------------------------------------------------------------

export interface WireKeyPattern {
  readonly key:          string;
  readonly match_type:   MatchType;
  readonly mask_strategy: MaskStrategy;
  readonly pattern:      string | null;
  readonly mask_char:    string;
  readonly separator:    string;
}

export interface WirePiiMaskConfig {
  readonly scan_depth:   string;
  readonly key_patterns: WireKeyPattern[];
}

export interface WireRouteEntry {
  readonly method: string;
  readonly path:   string;
  readonly reason: string | null;
}

export interface WireRouteBlockConfig {
  readonly blocked_routes:   WireRouteEntry[];
  readonly response_status:  number;
  readonly response_body:    Record<string, unknown>;
}

export interface WireHeaderInjectConfig {
  readonly headers: Record<string, string>;
}

export interface WireRule {
  readonly rule_id:   string;
  readonly rule_type: RuleType;
  readonly config:    WirePiiMaskConfig | WireRouteBlockConfig | WireHeaderInjectConfig | Record<string, unknown>;
}

export interface WireTargets {
  readonly routes: {
    readonly include: string[];
    readonly exclude: string[];
  };
  readonly http_methods: string[];
}

export interface WireRuntimeInstructionPayload {
  readonly instruction_id:   string;
  readonly instruction_type: string;
  readonly priority:         number;
  readonly ttl_seconds:      number;
  readonly effective_at:     number;
  readonly expires_at:       number;
  readonly targets:          WireTargets;
  readonly rules:            WireRule[];
  readonly checksum:         string;
}

// ---------------------------------------------------------------------------
// ExtractionRequest payload (Mode A — AST code extraction, future sprint)
// ---------------------------------------------------------------------------

export interface WireExtractionRequestPayload {
  readonly extraction_id:          string;
  readonly extraction_type:        string;
  readonly repository:             Record<string, string>;
  readonly targets:                unknown[];
  readonly include_ast:            boolean;
  readonly include_docblock:       boolean;
  readonly include_line_numbers:   boolean;
  readonly max_lines_per_symbol:   number;
  readonly callback_url:           string;
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

export interface HandshakeRequest {
  readonly connection_key:    string;
  readonly site_url:          string;
  readonly site_name:         string | null;
  readonly language_runtime:  'node';
  readonly runtime_version:   string;
  readonly framework:         string | null;
  readonly framework_version: string | null;
  readonly agent_version:     string | null;
  readonly environment:       'local' | 'staging' | 'production';
  readonly capabilities:      AgentCapabilities;
  readonly webhook_url:       string | null;
}

export interface AgentCapabilities {
  readonly mode_a_ast:         boolean;
  readonly mode_b_interceptor: boolean;
  readonly redis_available:    boolean;
  readonly git_access:         boolean;
}

export interface HandshakeResponse {
  readonly status:    'accepted';
  readonly client_id: string;
  readonly token:     string;
  readonly instruction_channel: {
    readonly type:                   'webhook' | 'polling';
    readonly poll_url:               string;
    readonly poll_interval_seconds:  number;
  };
}

// ---------------------------------------------------------------------------
// Stored connection config (written to disk by the connect command)
// ---------------------------------------------------------------------------

export interface ConnectionConfig {
  readonly client_id:            string;
  readonly token:                string;   // raw token — stored only locally, never sent back
  readonly saas_url:             string;
  readonly channel_type:         'webhook' | 'polling';
  readonly poll_url:             string;
  readonly poll_interval_seconds: number;
  readonly connected_at:         string;   // ISO-8601
}
