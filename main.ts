// Breakout rider: a long-only cbBTC bot for the make.fun BTC race.
// It reads one 1-minute bar per batch (hello, then a batch per bar, then
// done) and answers each batch with its orders. The rule rides a breakout
// and leaves only on a trailing stop, so it pays the ~26 bps round trip
// once per move instead of churning on every wiggle.

import { runBars } from './vendor/makefun-bars.ts';

// The asset we trade. The universe holds one symbol, CBBTC; we read it from
// the hello so the bot follows whatever the harness names.
let SYM = 'CBBTC';

// Closes we have seen, as plain numbers (raw price units, exact in a
// double). Returns and the stop are ratios, so the price scale cancels out.
const closes: number[] = [];

// Highest close since entry; the trailing stop hangs 2.5% below it.
let peak = 0;

// Entry: 60-minute log return above +0.8%.
// Exit: close 2.5% below the peak close since entry.
const ENTRY_60 = 0.008;
const TRAIL = 0.025;
const SLIP_BPS = 200;

// Slow-trend branch: 240-minute log return above +1.5% with the close
// above its 120-bar exponential average. Fallback: after bar 1200, a
// 30-minute return above +0.3% gets us into at least one trade.
const ENTRY_240 = 0.015;
const EMA_LEN = 120;
const EMA_ALPHA = 2 / (EMA_LEN + 1);
const ENTRY_30 = 0.003;
const FALLBACK_BAR = 1200;
let ema = 0;

await runBars({
  onHello(state) {
    const first = state.hello.symbols[0];
    if (first) SYM = first.symbol;
  },
  onBatch(state, batch) {
    // A warm-up batch is for history only; any order on it is rejected.
    if (state.warmingUp) return [];
    // Only a bar for our symbol advances the history; a minute with no
    // sample carries no bar and no new information.
    const bar = batch.bars.find((b) => b.symbol === SYM);
    if (!bar) return [];
    const close = Number(bar.c);
    closes.push(close);
    // Keep the 120-bar exponential average current for the slow branch.
    ema = ema === 0 ? close : EMA_ALPHA * close + (1 - EMA_ALPHA) * ema;

    const pos = state.positions.get(SYM);
    const held = pos !== undefined && pos.qty > 0n;

    if (!held) {
      // Flat: look for a breakout over the last 60 bars.
      if (closes.length >= 60) {
        const ago = closes[closes.length - 60];
        if (Math.log(close / ago) > ENTRY_60) {
          peak = close;
          return [{ side: 'buy', symbol: SYM, notional_quote_units: state.cash, max_slippage_bps: SLIP_BPS }];
        }
      }
      // Slow grind that never spikes 0.8% in an hour: a 240-minute return
      // above +1.5% with the close above its 120-bar average.
      if (closes.length >= 240) {
        const ago = closes[closes.length - 240];
        if (Math.log(close / ago) > ENTRY_240 && close > ema) {
          peak = close;
          return [{ side: 'buy', symbol: SYM, notional_quote_units: state.cash, max_slippage_bps: SLIP_BPS }];
        }
      }
      // Late fallback: after bar 1200, a 30-minute return above +0.3% puts
      // us in, so the race window always carries at least one trade.
      if (closes.length > FALLBACK_BAR && closes.length >= 30) {
        const ago = closes[closes.length - 30];
        if (Math.log(close / ago) > ENTRY_30) {
          peak = close;
          return [{ side: 'buy', symbol: SYM, notional_quote_units: state.cash, max_slippage_bps: SLIP_BPS }];
        }
      }
      return [];
    }

    // Long: track the peak and leave only on the trailing stop.
    if (close > peak) peak = close;
    if (close < peak * (1 - TRAIL)) {
      peak = 0;
      return [{ side: 'sell', symbol: SYM, qty: pos.qty, max_slippage_bps: SLIP_BPS }];
    }
    return [];
  },
});
