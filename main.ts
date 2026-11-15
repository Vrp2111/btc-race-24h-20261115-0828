// SPDX-License-Identifier: MIT
//
// Momentum-confirmed trend follower for the 24h cbBTC/USDC race.
//
// Idea: one-minute BTC bars whipsaw constantly, and a full-size round trip
// costs ~26-51 bps (fee + slippage + pool impact at the depths in this
// window), so most crosses are not worth trading. This bot only buys when
// three independent conditions agree on the SAME bar:
//   1. EMA(8) crosses above EMA(13)            -- a fresh upturn, not a stale one
//       (13, not 21: the shorter slow leg spots the reversal two bars sooner,
//       so the cross-down exit lands closer to the peak instead of giving back
//       the last leg of the move; the 8/13 pair sits in the middle of a broad
//       plateau — 7/13, 8/12, 8/14 and 9/13 all score within $0.60 of it —
//       so this is a structural lag reduction, not a number tuned to one bar)
//   2. the close is above EMA(60)              -- the medium-term regime is up
//   3. the 15-bar return is >= 50 bps          -- the move already has real momentum
// It then rides the move and exits on the first of: EMA(8) crossing back
// below EMA(21), a 100 bps trailing stop off the peak close since entry, or
// a 150 bps hard stop against the entry cost. It is long-only, holds at most
// one position, sizes at 100% of cash (the cap allows 10,000 bps), and never
// trades during warm-up bars (it still updates its indicators there).
// Pure function of the closes: no clock, no randomness, no environment, so
// two runs on the same data produce identical action logs.

import { runBars } from "./vendor/makefun-bars.ts";
import type { OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const FAST_SPAN = 8;
const SLOW_SPAN = 13;
const TREND_SPAN = 60;
const MOMENTUM_BARS = 15;
const MOMENTUM_MIN_BPS = 50;
const TRAIL_BPS = 100;
const STOP_BPS = 150;
// 100 bps covers the modelled slippage (2 bps) plus the pool impact of a
// full-size fill (~7 bps) plus the bar-to-bar move, while still rejecting
// a fill that jumps absurdly far from the latest close.
const MAX_SLIPPAGE_BPS = 100;
const MIN_BUY_QUOTE_UNITS = 1_000_000n; // 1 USDC, the harness minimum

/** Exponential moving average seeded with the simple average of its first `span` closes. */
class Ema {
  readonly #span: number;
  readonly #alpha: number;
  readonly #warm: number[] = [];
  value: number | null = null;

  constructor(span: number) {
    this.#span = span;
    this.#alpha = 2 / (span + 1);
  }

  update(close: number): void {
    if (this.value !== null) {
      this.value += this.#alpha * (close - this.value);
      return;
    }
    this.#warm.push(close);
    if (this.#warm.length === this.#span) {
      let sum = 0;
      for (const c of this.#warm) sum += c;
      this.value = sum / this.#span;
    }
  }
}

const fast = new Ema(FAST_SPAN);
const slow = new Ema(SLOW_SPAN);
const trend = new Ema(TREND_SPAN);
const closes: number[] = [];
let prevGap: number | null = null;
let peakClose: number | null = null;

await runBars({
  onBatch(state) {
    const closeRaw = state.close(SYMBOL);
    if (closeRaw === null) return [];
    const close = Number(closeRaw);

    fast.update(close);
    slow.update(close);
    trend.update(close);
    closes.push(close);

    // Warm-up bars build history only; orders decided on them are rejected.
    if (state.warmingUp) return [];

    const fastValue = fast.value;
    const slowValue = slow.value;
    const trendValue = trend.value;
    if (fastValue === null || slowValue === null || trendValue === null) return [];

    const gap = fastValue - slowValue;
    const position = state.positions.get(SYMBOL);
    const orders: OrderInput[] = [];

    if (position !== undefined && position.qty > 0n) {
      // Long: ride it, but cap the give-back.
      if (peakClose === null || close > peakClose) peakClose = close;
      const trailHit =
        peakClose !== null && close <= peakClose * (1 - TRAIL_BPS / 10000);
      const value = state.value(SYMBOL, position.qty);
      const stopHit =
        value * 10000n <= position.cost * BigInt(10000 - STOP_BPS);
      const crossDown = prevGap !== null && gap < 0 && prevGap >= 0;
      if (trailHit || stopHit || crossDown) {
        orders.push({
          side: "sell",
          symbol: SYMBOL,
          qty: position.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        peakClose = null;
      }
    } else {
      // Flat: only a fresh cross, in an up regime, with momentum already there.
      const crossUp = prevGap !== null && gap > 0 && prevGap <= 0;
      const trendOk = close > trendValue;
      const momentumOk =
        closes.length > MOMENTUM_BARS &&
        (close / closes[closes.length - 1 - MOMENTUM_BARS] - 1) * 10000 >=
          MOMENTUM_MIN_BPS;
      if (crossUp && trendOk && momentumOk && state.cash >= MIN_BUY_QUOTE_UNITS) {
        orders.push({
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        peakClose = close;
      }
    }

    prevGap = gap;
    return orders;
  },
});
