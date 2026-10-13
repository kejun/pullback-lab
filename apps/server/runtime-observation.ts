import { performance } from "node:perf_hooks";

/** Process observation clocks, independent of the market/replay event clock. */
export interface ObservationClock {
  wallNow(): number;
  monotonicNow(): number;
}
const realWallNow = Date.now.bind(Date);
const realMonotonicNow = performance.now.bind(performance);
export const processObservationClock: ObservationClock = {
  wallNow: realWallNow,
  monotonicNow: realMonotonicNow,
};
export const MAX_OBSERVATION_GAP_MS = 5000;
export const MAX_OBSERVATION_CLOCK_DIVERGENCE_MS = 1000;

/** This detects lost observation or uncertain clocks; it does not diagnose OS sleep. */
export class RuntimeObservation {
  private prior: { wall: number; mono: number } | undefined;
  constructor(
    private readonly clock: ObservationClock = processObservationClock,
  ) {}
  reset(): void {
    this.prior = undefined;
    this.observe();
  }
  private sample() {
    return { wall: this.clock.wallNow(), mono: this.clock.monotonicNow() };
  }
  private valid(next: { wall: number; mono: number }): boolean {
    if (!Number.isFinite(next.wall) || !Number.isFinite(next.mono))
      return false;
    if (!this.prior) return true;
    const wall = next.wall - this.prior.wall;
    const mono = next.mono - this.prior.mono;
    return (
      wall >= 0 &&
      mono >= 0 &&
      wall <= MAX_OBSERVATION_GAP_MS &&
      mono <= MAX_OBSERVATION_GAP_MS &&
      Math.abs(wall - mono) <= MAX_OBSERVATION_CLOCK_DIVERGENCE_MS
    );
  }
  /** Read-only views cannot advance the heartbeat and conceal a pending gap. */
  healthy(): boolean {
    return this.valid(this.sample());
  }
  observe(): boolean {
    const next = this.sample();
    if (!this.valid(next)) return false;
    this.prior = next;
    return true;
  }
}
