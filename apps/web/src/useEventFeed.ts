import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DecisionEventSummary,
  EventCounts,
  EventPage,
} from "../../../packages/contracts/index";
import { api, ApiError } from "./api";

const EMPTY_COUNTS: EventCounts = {
  total: 0,
  unread: 0,
  pending: 0,
  taken: 0,
  skipped: 0,
};
type FeedBatch = Pick<
  EventPage,
  "events" | "feedCursor" | "feedRevision" | "feedEpoch" | "hasMore" | "counts"
>;

export function mergeEventSummaries(
  previous: DecisionEventSummary[],
  incoming: DecisionEventSummary[],
) {
  const rows = new Map(previous.map((event) => [event.id, event]));
  for (const event of incoming) {
    const old = rows.get(event.id);
    if (!old || event.changeSeq >= old.changeSeq) rows.set(event.id, event);
  }
  return [...rows.values()].sort((a, b) => b.seq - a.seq);
}

/** Keep paged rows and form state independent from stream reconnections. */
export function useEventFeed(enabled: boolean) {
  const [events, setEvents] = useState<DecisionEventSummary[]>([]);
  const [counts, setCounts] = useState<EventCounts>(EMPTY_COUNTS);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState("连接中");
  const [authExpired, setAuthExpired] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);
  const [initialCursor, setInitialCursor] = useState<string | null>(null);
  const revision = useRef(-1);
  const epoch = useRef<string | null>(null);
  const retiredEpochs = useRef(new Set<string>());
  const boundary = useRef<string | null>(null);
  const initialized = useRef(false);
  const loadSequence = useRef(0);
  const loadingRef = useRef(false);

  const acceptBatch = useCallback((batch: FeedBatch) => {
    if (epoch.current !== batch.feedEpoch) return;
    setEvents((previous) => mergeEventSummaries(previous, batch.events));
    if (batch.feedRevision >= revision.current) {
      revision.current = batch.feedRevision;
      setCounts(batch.counts);
    }
  }, []);
  const acceptPage = useCallback(
    (page: EventPage) => {
      if (retiredEpochs.current.has(page.feedEpoch)) return;
      if (epoch.current !== page.feedEpoch) {
        if (epoch.current !== null) {
          retiredEpochs.current.add(epoch.current);
          setResetVersion((version) => version + 1);
        }
        epoch.current = page.feedEpoch;
        revision.current = -1;
        initialized.current = false;
        loadSequence.current++;
        loadingRef.current = false;
        setLoadingOlder(false);
        setEvents([]);
      }
      acceptBatch(page);
      if (!initialized.current) {
        initialized.current = true;
        boundary.current = page.beforeCursor;
        setHasMore(page.hasMore);
        setInitialCursor(page.feedCursor);
      }
    },
    [acceptBatch],
  );

  const loadOlder = useCallback(async () => {
    if (loadingRef.current || !boundary.current) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    setError(null);
    const requested = ++loadSequence.current;
    try {
      const page = await api<EventPage>(
        `/events?before=${encodeURIComponent(boundary.current)}&limit=50`,
      );
      if (
        requested !== loadSequence.current ||
        page.feedEpoch !== epoch.current
      )
        return;
      acceptBatch(page);
      boundary.current = page.beforeCursor;
      setHasMore(page.hasMore);
    } catch (cause) {
      if (requested === loadSequence.current)
        setError(
          cause instanceof Error ? cause.message : "较早记录暂时无法读取。",
        );
    } finally {
      if (requested === loadSequence.current) {
        loadingRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [acceptBatch]);

  useEffect(() => {
    if (enabled) return;
    loadSequence.current++;
    loadingRef.current = false;
    initialized.current = false;
    boundary.current = null;
    revision.current = -1;
    epoch.current = null;
    retiredEpochs.current.clear();
    setInitialCursor(null);
    setEvents([]);
    setCounts(EMPTY_COUNTS);
    setHasMore(false);
    setLoadingOlder(false);
    setError(null);
    setAuthExpired(false);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !initialCursor) return;
    let active = true;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resetFailures = 0;
    let connectionSerial = 0;
    let restoring = false;
    let authCheckPending = false;
    let authCheckAt = 0;
    let closedFailures = 0;
    let sessionExpired = false;
    const abort = new AbortController();
    const retryClosedStream = () => {
      if (
        !active ||
        restoring ||
        sessionExpired ||
        source?.readyState !== EventSource.CLOSED
      )
        return;
      const connection = connectionSerial;
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          if (active && connection === connectionSerial) void restore();
        },
        Math.min(1000 * 2 ** closedFailures++, 30000),
      );
    };
    const connect = (cursor: string) => {
      if (!active) return;
      const connection = ++connectionSerial;
      source = new EventSource(
        `/api/events/stream?after=${encodeURIComponent(cursor)}`,
      );
      source.onopen = () => {
        if (active && connection === connectionSerial) {
          closedFailures = 0;
          setStream("已连接");
        }
      };
      source.onerror = () => {
        if (!active || connection !== connectionSerial) return;
        setStream("正在重连");
        // A 401 during the handshake never reaches the stream's auth-expired event.
        // Distinguish a lost session from an ordinary network interruption.
        const permanentlyClosed = source?.readyState === EventSource.CLOSED;
        if (
          authCheckPending ||
          (!permanentlyClosed && Date.now() - authCheckAt < 5000)
        )
          return;
        authCheckPending = true;
        authCheckAt = Date.now();
        const probeAbort = new AbortController();
        const cancelProbe = () => probeAbort.abort();
        abort.signal.addEventListener("abort", cancelProbe, { once: true });
        const probeTimeout = setTimeout(cancelProbe, 8000);
        void api<{ authenticated: boolean }>("/session", "GET", undefined, {
          signal: probeAbort.signal,
        })
          .then((session) => {
            if (
              active &&
              connection === connectionSerial &&
              !session.authenticated
            ) {
              source?.close();
              connectionSerial++;
              sessionExpired = true;
              setStream("登录已过期");
              setAuthExpired(true);
            }
          })
          .catch(() => {
            /* Recovering connections retry natively; CLOSED needs an explicit retry. */
          })
          .finally(() => {
            clearTimeout(probeTimeout);
            abort.signal.removeEventListener("abort", cancelProbe);
            authCheckPending = false;
            // A second error may have closed this stream while the probe was pending.
            retryClosedStream();
          });
      };
      source.addEventListener("events", (message) => {
        if (!active || connection !== connectionSerial) return;
        try {
          const batch = JSON.parse((message as MessageEvent).data) as FeedBatch;
          if (
            Array.isArray(batch.events) &&
            Number.isSafeInteger(batch.feedRevision)
          )
            acceptBatch(batch);
        } catch {
          source?.close();
          void restore();
        }
      });
      source.addEventListener("auth-expired", () => {
        if (!active || connection !== connectionSerial) return;
        source?.close();
        connectionSerial++;
        sessionExpired = true;
        setStream("登录已过期");
        setAuthExpired(true);
      });
      source.addEventListener("reset", () => {
        if (!active || connection !== connectionSerial) return;
        source?.close();
        void restore();
      });
    };
    const restore = async () => {
      if (!active || restoring) return;
      restoring = true;
      clearTimeout(timer);
      connectionSerial++;
      setStream("正在恢复记录");
      try {
        const page = await api<EventPage>(
          "/events?limit=50",
          "GET",
          undefined,
          { signal: abort.signal },
        );
        if (!active) return;
        // Reconnect within an epoch preserves older rows. A restored database
        // replaces only server cache; drafts remain separate and need rechecking.
        loadSequence.current++;
        loadingRef.current = false;
        setLoadingOlder(false);
        acceptPage(page);
        boundary.current = page.beforeCursor;
        setHasMore(page.hasMore);
        setError(null);
        resetFailures = 0;
        restoring = false;
        connect(page.feedCursor);
      } catch (cause) {
        if (!active) return;
        restoring = false;
        if (cause instanceof ApiError && cause.status === 401) {
          sessionExpired = true;
          setStream("登录已过期");
          setAuthExpired(true);
          return;
        }
        setError(cause instanceof Error ? cause.message : "记录快照恢复失败。");
        timer = setTimeout(
          () => void restore(),
          Math.min(1000 * 2 ** resetFailures++, 30000),
        );
      }
    };
    connect(initialCursor);
    return () => {
      active = false;
      source?.close();
      abort.abort();
      clearTimeout(timer);
    };
  }, [enabled, initialCursor, acceptBatch, acceptPage]);

  return {
    events,
    counts,
    hasMore,
    loadingOlder,
    error,
    stream,
    authExpired,
    resetVersion,
    acceptPage,
    loadOlder,
  };
}
