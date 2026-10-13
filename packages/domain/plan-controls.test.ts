import { describe, expect, it } from "vitest";
import { chaseRatio } from "./plan-controls.js";

describe("frozen plan chase percentage conversion", () => {
  it.each([
    ["3", "0.03"],
    ["0", "0"],
    ["0.000", "0"],
    ["2.9999999999999999999999", "0.029999999999999999999999"],
    ["3.0000000000000000000001", "0.030000000000000000000001"],
    [
      "1234567890".repeat(6) + ".1234",
      "1234567890".repeat(5) + "12345678.901234",
    ],
  ])(
    "converts %s percentage points to %s without precision loss",
    (maxPercent, ratio) => {
      expect(chaseRatio({ chaseLimit: { enabled: true, maxPercent } })).toBe(
        ratio,
      );
    },
  );

  it("omits absent and disabled limits", () => {
    expect(chaseRatio({})).toBeUndefined();
    expect(chaseRatio({ chaseLimit: { enabled: false } })).toBeUndefined();
    expect(
      chaseRatio({ chaseLimit: { enabled: false, maxPercent: "3" } }),
    ).toBeUndefined();
  });

  it.each([undefined, "-1", "NaN", "1e3", "1".repeat(65)])(
    "rejects unsupported enabled percentage %s",
    (maxPercent) => {
      expect(() =>
        chaseRatio({ chaseLimit: { enabled: true, maxPercent } }),
      ).toThrow();
    },
  );
});
