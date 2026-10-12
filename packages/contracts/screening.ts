/** Editable C-class engineering presets. Indicator formulas remain screening-v1. */
export interface ScreeningParameters {
  minimumAdv20: { US: string; CN: string };
  adrMinPct: string;
  adrMaxPct: string;
  limitPerMarket: number;
}

/** A user-confirmed, immutable version of the screening parameters. */
export interface ScreeningRuleVersion {
  version: number;
  hash: string;
  algorithmVersion: string;
  parameters: ScreeningParameters;
  /** Null only for a legacy confirmation flag whose time was not recorded. */
  confirmedAt: number | null;
  confirmationBasis: "USER_CONFIRMED" | "LEGACY_CONFIRMED_FLAG";
  source: "C_ENGINEERING_TEST_PRESET";
}
