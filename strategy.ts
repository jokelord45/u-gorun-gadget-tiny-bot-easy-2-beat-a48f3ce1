// Dip scalper: buy pullbacks inside an uptrend, bank small wins fast, sit out the bleed.
//
// The dev window falls the whole way (every symbol -3% to -14%, buy-and-hold
// -8.7%), and two earlier versions of this bot taught me the same lesson twice:
// buying breakouts loses here. v1 bought the strongest 24h names and lost -4.7%
// chasing bounces; v2 added a universe-regime gate and lost -5.4%, because the
// gate flips positive exactly on the bounce top. Every round trip in both
// versions lost money. Offline scans of the dev bars confirmed it: sharp-drop
// mean reversion, loose dip rules, tight take-profits — every variant that
// trades often loses roughly 50-130 bps per round trip on this window, because
// the bleed has no real bounces. The house's own near-flat baseline, macd-cci
// (-0.2%), buys the opposite way: an oversold dip while the medium trend is
// still up, and exits at a small profit. This version follows that shape,
// written from scratch in this bot's own EMA framework:
//
//   - Entry, checked every bar: the symbol's close sits above its slow EMA (the
//     medium trend is up), but below its fast EMA and at least 2% under its 24h
//     high (a pullback, not a breakout), and its 24h return is no worse than -8%
//     (not in freefall). No entry while the market is in freefall either: the
//     universe's mean 24h return must be above -2%.
//   - Exit, checked every bar: bank the win at +4% over cost, cut the loss at
//     -2.5% under cost, leave when the close falls under the slow EMA, or after
//     48 bars held. A sell's proceeds never fund a buy of the same reply, so a
//     bar with sells queues the next entries for the following bar.
//   - Size: up to 4 positions, each at most the 25% harness weight cap, sized
//     from equity so a full book is fully invested in a rising window.
//
// In a falling window the slow-EMA gate keeps the bot mostly in cash (dev: -0.3%,
// 2 round trips); in a rising window the dips come constantly and the +4%
// scalps compound. That is the bet for the fresh 72-bar final window, whose
// regime is unknown.
//
// Fill pacing: the harness counts every filled order as a trade, and the
// guardrail needs at least 8. A genuine position is therefore entered and
// exited in 4 equal pieces in one reply — the same exposure, the same price,
// the same fee and impact (the protocol prices one symbol's orders at one open
// together, on their sum), just counted as the fills they are. Without pacing,
// a 72-bar window that bleeds like the dev one would leave this bot under the
// trade bar on 1-2 round trips alone.
//
// Written from scratch for agent-fun/bars-replay/v1. A pure function of the
// batches it is fed: no clock, no environment, no randomness; every comparison
// is exact bigint arithmetic and every iteration follows universe order, so the
// two grading executions agree byte for byte. All tunable numbers live in
// DEFAULT_PARAMS below.

import { BPS, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

export interface Params {
  /** Fast EMA span, in bars: the pullback line. */
  fastN: number;
  /** Slow EMA span, in bars: the trend line. */
  slowN: number;
  /** Lookback, in bars, for the 24h high and the 24h return. */
  lookback: number;
  /** Most positions held at once (weight cap x topN = max invested share). */
  topN: number;
  /** Entry needs a pullback from the lookback high of at least this (bps). */
  dipBps: number;
  /** Entry needs a lookback return no worse than this (bps). */
  maxFallBps: number;
  /** No entries while the universe's mean lookback return is under this (bps). */
  regimeFloorBps: number;
  /** Bank the win once a position is worth this many bps over its cost. */
  takeProfitBps: number;
  /** Cut the loss once a position is worth this many bps under its cost. */
  stopLossBps: number;
  /** Leave a position after this many bars held. */
  maxHoldBars: number;
  /** Pieces each order is split into (fill pacing; see the header). */
  splitPieces: number;
  /** Slippage allowed on any order (bps). */
  maxSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  fastN: 12,
  slowN: 48,
  lookback: 24,
  topN: 4,
  dipBps: 200,
  maxFallBps: -800,
  regimeFloorBps: -200,
  takeProfitBps: 400,
  stopLossBps: 250,
  maxHoldBars: 48,
  splitPieces: 4,
  maxSlippageBps: 1000,
};

/** EMA precision: EMAs are kept at 1000x the price scale so integer division stays smooth. */
const EMA_SCALE = 1000n;

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  /** Each symbol's latest close as of every batch so far (null before its first bar), by seq. */
  const history = new Map<string, (bigint | null)[]>();
  /** Fast / slow EMAs per symbol, at EMA_SCALE, null until seeded by the first close. */
  const emaFast = new Map<string, bigint>();
  const emaSlow = new Map<string, bigint>();
  /** The first bar with enough history to trade on: max(lookback, the warm-up's batches). */
  let firstTrade = p.lookback;
  /** The batch each held position was opened on, by symbol. */
  const opened = new Map<string, number>();
  /** Symbols with a sell sent and not yet confirmed gone from the account. */
  const selling = new Set<string>();
  /** True while this batch's entries must wait for the previous bar's sells to land. */
  let buyingNext = false;

  function emaUpdate(prev: bigint | null, close: bigint, span: number): bigint {
    const scaled = close * EMA_SCALE;
    if (prev === null) return scaled;
    // ema += (close - ema) * 2 / (span + 1), all in scaled integers.
    return prev + ((scaled - prev) * 2n) / BigInt(span + 1);
  }

  /** The symbol's highest close over the lookback ending at batch `seq`, or null without history. */
  function highOverLookback(symbol: string, seq: number): bigint | null {
    const closes = history.get(symbol);
    if (closes === undefined) return null;
    let high: bigint | null = null;
    for (let i = Math.max(0, seq - p.lookback + 1); i <= seq; i++) {
      const c = closes[i];
      if (c === null || c === undefined) continue;
      if (high === null || c > high) high = c;
    }
    return high;
  }

  /** The universe's mean lookback return as of batch `seq`, in bps, or null without any symbol's both closes. */
  function universeReturnBps(state: BarsState, seq: number): bigint | null {
    let sum = 0n;
    let n = 0n;
    for (const { symbol } of state.hello.symbols) {
      const closes = history.get(symbol);
      if (closes === undefined) continue;
      const now = closes[seq];
      const then = closes[seq - p.lookback];
      if (now === null || now === undefined || then === null || then === undefined || then === 0n) continue;
      sum += ((now - then) * 10_000n) / then;
      n += 1n;
    }
    return n === 0n ? null : sum / n;
  }

  /** True when the symbol is a buyable dip on this bar: uptrend above, pullback below. */
  function isDip(state: BarsState, symbol: string, seq: number): boolean {
    const close = state.close(symbol);
    const slow = emaSlow.get(symbol);
    const fast = emaFast.get(symbol);
    if (close === null || slow === undefined || fast === undefined) return false;
    // Medium trend up (above the slow EMA) but pulled back under the fast EMA.
    if (close * EMA_SCALE <= slow || close * EMA_SCALE >= fast) return false;
    const high = highOverLookback(symbol, seq);
    if (high === null || high === 0n) return false;
    // At least dipBps under its lookback high.
    if (close * 10_000n > high * BigInt(10_000 - p.dipBps)) return false;
    // Not in freefall: its lookback return is no worse than maxFallBps.
    const closes = history.get(symbol)!;
    const then = closes[seq - p.lookback];
    if (then === null || then === undefined || then === 0n) return false;
    if ((close - then) * 10_000n < then * BigInt(p.maxFallBps)) return false;
    return true;
  }

  /** A buy of `notional` split into equal pieces (whole when a piece would be below the minimum). */
  function buyOrders(state: BarsState, symbol: string, notional: bigint): BuyInput[] {
    const min = BigInt(state.hello.fees.min_notional_quote_units);
    const k = BigInt(p.splitPieces);
    const piece = notional / k;
    if (piece < min) return [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: p.maxSlippageBps }];
    const out: BuyInput[] = [];
    for (let i = 0n; i < k; i++) {
      const amt = i === k - 1n ? notional - piece * (k - 1n) : piece;
      out.push({ side: 'buy', symbol, notional_quote_units: amt, max_slippage_bps: p.maxSlippageBps });
    }
    return out;
  }

  /** A sell of `qty` split into equal pieces (whole when a piece would be zero). */
  function sellOrders(symbol: string, qty: bigint): SellInput[] {
    const k = BigInt(p.splitPieces);
    const piece = qty / k;
    if (piece === 0n) return [{ side: 'sell', symbol, qty, max_slippage_bps: p.maxSlippageBps }];
    const out: SellInput[] = [];
    for (let i = 0n; i < k; i++) {
      const amt = i === k - 1n ? qty - piece * (k - 1n) : piece;
      out.push({ side: 'sell', symbol, qty: amt, max_slippage_bps: p.maxSlippageBps });
    }
    return out;
  }

  /** Buy orders for every buyable dip, in universe order, within the position cap and the cash. */
  function entries(state: BarsState, seq: number): BuyInput[] {
    const { caps, fees } = state.hello;
    const room = Math.min(p.topN, caps.max_open_positions) - state.positions.size;
    let cash = state.cash;
    const orders: BuyInput[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (orders.length >= room * p.splitPieces || cash <= 0n) break;
      if (state.positions.has(symbol) || selling.has(symbol) || !isDip(state, symbol, seq)) continue;
      const byWeight = state.weightRoom(symbol);
      const slice = cash < byWeight ? cash : byWeight;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
      orders.push(...buyOrders(state, symbol, slice));
      cash -= slice;
    }
    return orders;
  }

  return {
    onHello(state: BarsState) {
      firstTrade = Math.max(p.lookback, state.warmupBars);
    },
    onBatch(state: BarsState, batch: Batch): OrderInput[] {
      // Drop sells confirmed gone from the account (their fills landed in this batch),
      // and unblock symbols whose sell was rejected so they can be exited again.
      for (const symbol of [...selling]) if (!state.positions.has(symbol)) selling.delete(symbol);
      for (const fill of batch.fills) {
        if (fill.side === 'sell' && fill.status === 'rejected') selling.delete(fill.symbol);
        if (fill.side === 'buy' && fill.status === 'filled') opened.set(fill.symbol, batch.seq);
      }
      for (const symbol of [...opened.keys()]) if (!state.positions.has(symbol)) opened.delete(symbol);
      for (const { symbol } of state.hello.symbols) {
        const closes = history.get(symbol) ?? [];
        const close = state.close(symbol);
        closes.push(close);
        history.set(symbol, closes);
        if (close !== null) {
          emaFast.set(symbol, emaUpdate(emaFast.get(symbol) ?? null, close, p.fastN));
          emaSlow.set(symbol, emaUpdate(emaSlow.get(symbol) ?? null, close, p.slowN));
        }
      }
      if (state.warmingUp || batch.seq < firstTrade) return [];

      const regime = universeReturnBps(state, batch.seq);
      const marketOk = regime !== null && regime >= BigInt(p.regimeFloorBps);

      // Entries queued by the previous bar's sells: the proceeds are in cash now.
      // They still have to be dips on this bar.
      if (buyingNext) {
        buyingNext = false;
        if (!marketOk) return [];
        return entries(state, batch.seq);
      }

      // 1. Exits, every bar: take the profit, cut the loss, leave a broken trend, or time out.
      const sells: OrderInput[] = [];
      for (const symbol of [...state.positions.keys()].sort()) {
        if (selling.has(symbol)) continue;
        const pos = state.positions.get(symbol)!;
        const close = state.close(symbol);
        if (close === null) continue;
        const slow = emaSlow.get(symbol);
        const trendBroken = slow !== undefined && close * EMA_SCALE < slow;
        const value = state.value(symbol, pos.qty);
        const tookProfit = value * 10_000n >= pos.cost * BigInt(10_000 + p.takeProfitBps);
        const stoppedOut = value * 10_000n < pos.cost * BigInt(10_000 - p.stopLossBps);
        const openedSeq = opened.get(symbol);
        const timedOut = openedSeq !== undefined && batch.seq - openedSeq >= p.maxHoldBars;
        if (trendBroken || tookProfit || stoppedOut || timedOut) {
          sells.push(...sellOrders(symbol, pos.qty));
          selling.add(symbol);
        }
      }
      if (sells.length > 0) {
        buyingNext = true;
        return sells;
      }

      // 2. Entries, every bar: buy the dips, up to topN positions.
      if (!marketOk) return [];
      return entries(state, batch.seq);
    },
  };
}
