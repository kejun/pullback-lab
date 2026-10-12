/** Safe to export: this report contains no credentials, paths, instruments or money. */
export interface OperationsStatus {
  reportVersion: 1;
  /** UTC milliseconds; observation time, not independent clock verification. */
  capturedAt: number;
  runtime: {
    nodeVersion: string;
    sqliteVersion: string;
    schemaVersion: number;
    journalMode: "wal" | "memory" | "unknown";
    synchronous: "FULL" | "UNKNOWN";
  };
  /** Filesystem capacity for the database, not the size of the database file. */
  disk: { totalBytes: number; availableBytes: number } | null;
  security: {
    secureCookiesConfigured: boolean;
    originConfigured: boolean;
    publicTls: "UNKNOWN";
  };
  funds: {
    present: boolean;
    generation: number | null;
    stale: boolean | null;
    confirmedAt: number | null;
  };
  counts: {
    plans: number;
    activePlans: number;
    reservations: number;
    activeReservations: number;
    takenPendingReservations: number;
    pendingFeedback: number;
    unreadEvents: number;
  };
  worker: {
    enabled: boolean;
    state: "DISABLED" | "IDLE" | "POLLING" | "BACKOFF" | "STOPPED" | "UNKNOWN";
    lastStartedAt: number | null;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    nextPollAt: number | null;
    quarantinedCount: number | null;
  };
  markets: { US: "UNKNOWN"; CN: "UNKNOWN" };
  clock: { status: "UNKNOWN"; checkedAt: null };
}
