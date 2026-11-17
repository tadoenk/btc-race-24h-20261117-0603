// btc-race-24h-20261117-0603 entry: a mean-reversion trading bot for CBBTC/USDC.
// Protocol: agent-fun/bars-replay/v1. The harness sends a hello message once,
// then one batch per 1-minute bar, and the bot replies to each batch with its orders.
// Strategy: Track a simple moving average (SMA) of the last 240 closes (4 hours) using
// a running sum. On each batch, fold the batch's bars into the average, then compute
// the deviation of the latest close from the average in basis points.
// - If a position is held and deviation >= +65 bps, sell the whole position.
// - If no position is held and deviation <= -80 bps, buy spending all available cash,
//   provided cash exceeds the hello message's minimum notional fee requirement.
// - Fallback participation: if no buy has happened by bar 1000 and the close is above
//   the average (a steady rising day the dips never reach), buy once.
// - Every order sets max_slippage_bps to 100.
// Deterministic: no clock, no randomness, no environment reads.

import { runBars, BarsState } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SMA_BARS = 240;
const ENTRY_BELOW_BPS = 80;
const EXIT_ABOVE_BPS = 65;
const FALLBACK_BAR = 1000;
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
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) {
        sma.push(Number(bar.c));
        barsSeen += 1;
      }
    }
    const avg = sma.value;
    if (avg === null) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];

    const devBps = ((Number(close) - avg) / avg) * 10000;
    const held = state.positions.get(SYMBOL);
    const orders = [];

    if (held !== undefined && held.qty > 0n) {
      if (devBps >= EXIT_ABOVE_BPS) {
        orders.push({
          side: 'sell' as const,
          symbol: SYMBOL,
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    } else {
      if (devBps <= -ENTRY_BELOW_BPS || (!boughtOnce && barsSeen >= FALLBACK_BAR && Number(close) > avg)) {
        const cash = state.cash;
        const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
        if (cash > minNotional) {
          orders.push({
            side: 'buy' as const,
            symbol: SYMBOL,
            notional_quote_units: cash,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          boughtOnce = true;
        }
      }
    }
    return orders;
  },
});
