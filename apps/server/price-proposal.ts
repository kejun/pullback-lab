import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Instrument } from "../../packages/contracts/index.js";
import { D, positive, str, type Dec } from "../../packages/domain/numeric.js";
import { ApiError, type Store } from "./store.js";

const priceString = z.string().max(192);
const proposal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("POINT"), displayPrice: priceString }).strict(),
  z
    .object({
      kind: z.literal("STEP"),
      price: priceString,
      steps: z
        .number()
        .int()
        .min(-100)
        .max(100)
        .refine((n) => n !== 0),
    })
    .strict(),
]);
export type PriceProposal = z.infer<typeof proposal>;

/** A drawing coordinate is only a proposal. No plan or funds are changed here. */
export function normalizePriceProposal(
  instrument: Instrument,
  input: PriceProposal,
) {
  if (!instrument.rulesVerified)
    throw new ApiError(
      422,
      "INSTRUMENT_RULES_UNVERIFIED",
      "价格步长尚未验证，请使用数值输入并先核对证券规则",
    );
  try {
    const tick = positive(instrument.tick, "tick");
    const value = positive(
      input.kind === "POINT" ? input.displayPrice : input.price,
      "price",
    );
    let price: Dec;
    if (input.kind === "POINT") {
      // Refuse graphics whose binary display resolution could collapse adjacent ticks.
      // This is a drawing-boundary check; quantization itself remains decimal arithmetic.
      const displayed = value.toNumber();
      if (
        !Number.isFinite(displayed) ||
        displayed <= 0 ||
        new D(String(Math.abs(displayed) * Number.EPSILON)).gte(tick.div(4))
      )
        throw new ApiError(
          422,
          "CHART_RESOLUTION_UNSAFE",
          "当前价格精度超出图表调价范围，请使用精确数值输入",
        );
      price = value.div(tick).toDecimalPlaces(0, D.ROUND_HALF_UP).mul(tick);
    } else {
      if (!value.mod(tick).isZero())
        throw new ApiError(
          422,
          "PRICE_NOT_ON_TICK",
          "当前价格不在合法步长上，请先修改数值输入",
        );
      const increment = tick.mul(input.steps);
      price = value.plus(increment);
      if (!price.minus(value).eq(increment))
        throw new Error("PRICE_PRECISION_OVERFLOW");
    }
    const result = str(price);
    // Re-parse after arithmetic to catch a precision/range overflow before returning it.
    if (!positive(result, "result").mod(tick).isZero())
      throw new Error("PRICE_PRECISION_OVERFLOW");
    return {
      price: result,
      tick: str(tick),
      instrumentRevision: createHash("sha256")
        .update(JSON.stringify(instrument))
        .digest("hex"),
      rounded: input.kind === "POINT" && !price.eq(value),
      basis:
        input.kind === "POINT"
          ? ("DISPLAY_PROPOSAL" as const)
          : ("EXACT_STEP" as const),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      400,
      "INVALID_PRICE_PROPOSAL",
      "调价必须使用大于零、精度受支持的十进制价格",
    );
  }
}

/** Register on the authenticated application scope so existing login/CSRF hooks apply. */
export function registerPriceProposalRoutes(
  app: FastifyInstance,
  store: Store,
) {
  app.post<{ Params: { id: string } }>(
    "/api/instruments/:id/price-proposal",
    async (request) => {
      const input = proposal.parse(request.body);
      return normalizePriceProposal(
        store.instrument(request.params.id).instrument,
        input,
      );
    },
  );
}
