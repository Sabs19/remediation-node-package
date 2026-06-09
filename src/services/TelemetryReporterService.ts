import axios from 'axios';
import type { ConnectionConfig } from '../types/wireProtocol.js';
import { logger } from '../logger.js';

export interface TelemetryEvent {
  route:            string;
  method:           string;
  instruction_type: string;
  latency_ms:       number;
  applied_at:       string;
}

/**
 * Fire-and-forget telemetry reporter.
 * Buffers events in memory and flushes to the SaaS every 5 seconds,
 * or immediately when the buffer reaches 50 events.
 * All errors are swallowed — telemetry must never impact request latency.
 */
export class TelemetryReporterService {
  private readonly url:      string;
  private readonly clientId: string;
  private readonly token:    string;
  private readonly buffer:   TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ConnectionConfig) {
    this.url      = config.saas_url.replace(/\/+$/, '') + '/api/remediation/v1/telemetry';
    this.clientId = config.client_id;
    this.token    = config.token;
  }

  record(event: TelemetryEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= 50) {
      this.flush();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), 5000);
    }
  }

  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    const events = this.buffer.splice(0);

    axios.post(this.url, { events }, {
      headers: {
        'X-Remediation-Client-Id': this.clientId,
        'X-Remediation-Token':     this.token,
      },
      timeout: 5000,
    }).catch((err: unknown) => {
      logger.debug('RemediationEngine: telemetry flush failed.', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
