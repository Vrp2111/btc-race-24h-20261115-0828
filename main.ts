// SPDX-License-Identifier: MIT
//
// Four-plan BTC trading bot for the 24h cbBTC/USDC race.
//
// One bot, four plans, one position. Each bar the bot reads the market
// regime from the closes only and picks the plan whose setup is present.
// When long, the exit logic of the plan that entered applies; the exit
// logic never switches mid-trade.
//
//   Plan A — Trend ride. Entry: EMA(8) crosses above EMA(13), close above
//     EMA(60), 15-bar return >= 50 bps. Exit: cross back down, 100 bps
//     trailing stop, 150 bps hard stop. For a genuine uptrend (EMA(60)
//     rising over the last 60 bars): ride the whole move.
//   Plan B — Small-profit collection. Same entry as A, but chosen when the
//     medium-term trend is still falling (a counter-trend bounce): exit at
//     a +100 bps profit target, then re-enter without a fresh cross while
//     EMA(8) stays above EMA(13), close stays above EMA(60) and the
//     15-bar return stays >= 150 bps. For choppy markets: bank small wins
//     instead of giving them back.
//   Plan C — Buy the dip. Entry: close >= 150 bps below EMA(60) (deep
//     oversold) with the 15-bar return back above +50 bps and the close
//     above EMA(8). Exit: +100 bps target, 75 bps trailing stop, 150 bps
//     hard stop, cross back down. For a capitulation V-bounce. Strict on
//     purpose: the dev window's dips all keep falling, so it never fires
//     there; it is insurance for a live window that does V.
//   Plan D — Breakout. Entry: close above the highest close of the last
//     60 bars with a 15-bar return >= 150 bps. Exit: 100 bps trailing
//     stop, 150 bps hard stop, cross back down. For a strong momentum
//     breakout that runs.
//
// Selector (when flat, in priority order): D, then A/B (the exit policy
// chosen by the EMA(60) 60-bar slope: >= 0 ride as A, < 0 bank as B),
// then B's re-entry arm, then C. Long only, one position, 100% of cash.
// On the dev window the selector picks B three times (the recovery is a
// counter-trend bounce: EMA(60) is still falling steeply at the entry, so
// it banks +100 bps targets and re-enters); C never fires there (the
// deepest oversold bar has a 15-bar return of -162 bps, still falling)
// and D never gets a separate entry (its breakout + momentum first shows
// while the bot is already long via B). A, C and D are live-window cover:
// a genuine uptrend, a capitulation V-bounce, and a strong breakout.
// Pure function of the closes: no clock, no randomness, no environment,
// so two runs on the same data produce identical action logs.

import { runBars } from "./vendor/makefun-bars.ts";
import type { OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const FAST_SPAN = 8;
const SLOW_SPAN = 13;
const TREND_SPAN = 60;
const MOMENTUM_BARS = 15;
const MOMENTUM_MIN_BPS = 50;
const MOMENTUM_STRONG_BPS = 150;
const BREAKOUT_BARS = 60;
const DIP_MIN_BPS = 150;
const TARGET_BPS = 100;
const TRAIL_BPS = 100;
const TRAIL_BPS_C = 75;
const STOP_BPS = 150;
// 100 bps covers the modelled slippage (2 bps) plus the pool impact of a
// full-size fill (~7 bps) plus the bar-to-bar move, while still rejecting
// a fill that jumps absurdly far from the latest close.
const MAX_SLIPPAGE_BPS = 100;
const MIN_BUY_QUOTE_UNITS = 1_000_000n; // 1 USDC, the harness minimum

type Plan = "A" | "B" | "C" | "D";

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
const trendHist: number[] = [];
let prevGap: number | null = null;
let peakClose: number | null = null;
let activePlan: Plan | null = null;
let reentryArmed = false;

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
    trendHist.push(trendValue);

    const gap = fastValue - slowValue;
    const position = state.positions.get(SYMBOL);
    const orders: OrderInput[] = [];

    // Regime measurements, from the closes only.
    const n = closes.length;
    const mom15 =
      n > MOMENTUM_BARS
        ? (close / closes[n - 1 - MOMENTUM_BARS] - 1) * 10000
        : null;
    const slope60 =
      trendHist.length > 60
        ? (trendValue / trendHist[trendHist.length - 61] - 1) * 10000
        : null;
    const dist60 = (close / trendValue - 1) * 10000;
    const breakout =
      n > BREAKOUT_BARS &&
      close > Math.max(...closes.slice(-BREAKOUT_BARS - 1, -1));

    if (position !== undefined && position.qty > 0n) {
      // Long: the exit logic of the plan that entered applies.
      if (peakClose === null || close > peakClose) peakClose = close;
      const value = state.value(SYMBOL, position.qty);
      const targetHit =
        (activePlan === "B" || activePlan === "C") &&
        value * 10000n >= position.cost * BigInt(10000 + TARGET_BPS);
      const trailBps = activePlan === "C" ? TRAIL_BPS_C : TRAIL_BPS;
      const trailHit =
        peakClose !== null && close <= peakClose * (1 - trailBps / 10000);
      const stopHit =
        value * 10000n <= position.cost * BigInt(10000 - STOP_BPS);
      const crossDown = prevGap !== null && gap < 0 && prevGap >= 0;
      if (targetHit || trailHit || stopHit || crossDown) {
        orders.push({
          side: "sell",
          symbol: SYMBOL,
          qty: position.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        reentryArmed = activePlan === "B" && targetHit;
        peakClose = null;
        activePlan = null;
      }
    } else {
      // Flat: pick one plan, in priority order: D, A/B, B re-entry, C.
      let plan: Plan | null = null;
      if (breakout && mom15 !== null && mom15 >= MOMENTUM_STRONG_BPS) {
        plan = "D";
      } else if (
        prevGap !== null &&
        gap > 0 &&
        prevGap <= 0 &&
        close > trendValue &&
        mom15 !== null &&
        mom15 >= MOMENTUM_MIN_BPS
      ) {
        plan = slope60 !== null && slope60 >= 0 ? "A" : "B";
      } else if (
        reentryArmed &&
        gap > 0 &&
        close > trendValue &&
        mom15 !== null &&
        mom15 >= MOMENTUM_STRONG_BPS
      ) {
        plan = "B";
      } else if (
        dist60 <= -DIP_MIN_BPS &&
        mom15 !== null &&
        mom15 >= MOMENTUM_MIN_BPS &&
        close > fastValue
      ) {
        plan = "C";
      }
      if (plan !== null && state.cash >= MIN_BUY_QUOTE_UNITS) {
        orders.push({
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        peakClose = close;
        activePlan = plan;
        reentryArmed = false;
      }
    }

    prevGap = gap;
    return orders;
  },
});
