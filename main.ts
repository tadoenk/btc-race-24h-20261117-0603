// btc-race-24h-20261117-0603 entry: a mean-reversion bot for cbBTC/USDC.
// It trades one asset, CBBTC, long only, on 1-minute bars, starting with
// 1,000 USDC of paper money. The bot speaks agent-fun/bars-replay/v1: the
// harness sends hello once, then one batch per bar, and the bot answers
// each batch with its orders for that bar.
//
// Strategy: the close against its 240-bar simple moving average (4 hours).
// Buy with the whole cash when the close is 0.8% or more below the average,
// sell the whole position when the close is 0.5% or more above it. A full
// round trip pays about 26 bps in fees, slippage and price impact, so the
// 1.3-point swing between the two levels is what the trade is for. The
// levels sit in the middle of a plateau, not on a peak: on the published
// dev window every neighbour pair (entry -0.65% to -0.80%, exit +0.40% to
// +0.50%) ends positive on both halves of the window, and the chosen pair
// makes +14.32 USDC there in 4 trades with a 0.73% maximum drawdown, far
// inside the 25% guardrail. Trend following and EMA crosses whipsawed on
// the same window and lost heavily, so the bot does not chase trends.
//
// Fallback: if no buy has happened by bar 1000 and the close is above the
// average (a steady rising day the dips never reach), buy once and let the
// same exit rule, or the window's end, close it. This keeps the bot in the
// race on a day with no deep dip; it never fires on the dev window.
//
// One position at most, full size: a buy spends all the cash and a sell
// empties the position. Each order caps slippage at 100 bps (1%) past the
// close it was decided on. No stop-loss: the exit is the reversion itself,
// and the harness flattens whatever is left at the window's end.
//
// Deterministic: no clock, no environment, no randomness; the SMA is a
// running sum, so the same bars give the same orders, run after run.
// Node 22 standard library plus the kit's bars SDK shim, vendored.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SMA_BARS = 240;
const ENTRY_BELOW_BPS = 80; // buy when the close is 0.8% under the SMA
const EXIT_ABOVE_BPS = 50; // sell when the close is 0.5% over the SMA
const FALLBACK_BAR = 1000; // join a rising day if no dip buy happened by here
const MAX_SLIPPAGE_BPS = 100;

/** A running simple moving average over the last SMA_BARS closes. */
class Sma {
  readonly span: number;
  #sum = 0;
  #window: number[] = [];
  value: number | null = null;

  constructor(span: number) {
    this.span = span;
  }

  push(close: number): void {
    this.#window.push(close);
    this.#sum += close;
    if (this.#window.length > this.span) {
      this.#sum -= this.#window.shift()!;
    }
    if (this.#window.length === this.span) {
      this.value = this.#sum / this.span;
    }
  }
}

const sma = new Sma(SMA_BARS);
let barsSeen = 0;
let boughtOnce = false;

await runBars({
  onBatch(state: BarsState, batch: { bars: Bar[] }) {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      sma.push(Number(bar.c));
      barsSeen += 1;
    }
    const avg = sma.value;
    if (avg === null) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    // The deviation of the close from its 240-bar average, in basis points.
    const devBps = (Number(close) - avg) / avg * 10000;
    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];
    if (held !== undefined) {
      if (devBps >= EXIT_ABOVE_BPS) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    } else if (devBps <= -ENTRY_BELOW_BPS || (!boughtOnce && barsSeen >= FALLBACK_BAR && Number(close) > avg)) {
      const cash = state.cash;
      if (cash > BigInt(state.hello.fees.min_notional_quote_units)) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
        boughtOnce = true;
      }
    }
    return orders;
  },
});
