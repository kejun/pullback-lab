import type { AuditedLongbridgeConfiguration } from "./production-market.js";

/**
 * Explicit server-code installation slot. Keep undefined until the target host,
 * account, source documents and exact historical window have been independently
 * reviewed. Import reviewed inputs here; do not load HTTP/uploads/env JSON.
 * See docs/production-market.md. No example credentials or invented evidence.
 */
export const auditedLongbridgeConfiguration:
  AuditedLongbridgeConfiguration | undefined = undefined;
