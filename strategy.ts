// Pump.fun Replay Sprint — a paper trading bot for the agent-fun/replay/v2 harness.
//
// Idea: most pump.fun coins die within minutes, but the ones that run show one signature
// early — several distinct wallets buying into a rising price over a short window, with the
// inflow accelerating rather than fading. This bot only buys that signature, starts small,
// and exits in two stages: it banks half the position at +30%, then lets the rest ride with
// a wide trailing stop, so one runner can pay for many small losers. Losers are cut fast on
// a stop-loss, a fading flow, a big dump, or a time limit. It never shorts, never uses
// leverage, and never reads the clock or any randomness: every decision comes from the batch
// stream, so two runs agree.
//
// The entrypoint runs on Node 22 (type stripping, no build step):
//   node main.ts
// It speaks the replay protocol through ./vendor/agentfun-bot.ts (the kit's own shim).

import type { Batch, BotState, OrderInput, Pubkey } from "./vendor/agentfun-bot.ts";

const LAMPORTS = 1e9;
// Curve + tx fees on a sell are about 1.25% of the quote; value() nets them out.
const CURVE_FEE = 0.0125;

interface Cfg {
  // Entry window, in slots.
  win: number;
  // Net SOL bought minus sold over the window.
  minNetSol: number;
  minBuys: number;
  minBuyers: number;
  // Price now vs price at the window start.
  minUp: number;
  maxUp: number;
  // Newer-half inflow must beat the older half by this factor.
  accel: number;
  // Price now must sit at least this close to the window high.
  nearHigh: number;
  // Largest single buyer may not take more than this share of buy SOL.
  maxTopShare: number;
  // Real SOL in the curve at entry.
  minRq: number;
  maxRq: number;
  // Slots since CreateEvent before an entry is allowed, and after which it is too stale.
  minAge: number;
  maxAge: number;
  // Slippage on buys (bps). Wide open: a coin pumping fast moves a lot in the
  // 2-slot latency, and a tight cap rejects exactly the entries we want.
  buySlipBps: number;
  // Sizing (SOL). One small buy per position; no pyramiding (it concentrated into dumps).
  firstBuy: number;
  maxStake: number;
  minBuy: number;
  // Exits.
  // Slots after opening during which the stop-loss and fade do not apply: fresh coins
  // are violently noisy, and the stop would dump the eventual runners in the first slots.
  stopGrace: number;
  stopLoss: number;
  // Stage one: bank this share of the tokens once value reaches cost * (1 + takeProfit1).
  takeProfit1: number;
  partialFrac: number;
  // Stage two: the rest rides a trailing stop, armed once value reaches cost * (1 + trailArm).
  trailArm: number;
  trail: number;
  fadeWin: number;
  fadeNet: number;
  maxHold: number;
  holdIfUp: number;
  // Re-entry control.
  cooldown: number;
  maxEntries: number;
  // Pacing: the run must end with a round trip on >= 20 coins. When fills or coins lag the
  // pace, open tiny probe round trips on liquid curves.
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  maxMain: number;
  maxExposure: number;
}

export const CFG: Cfg = {
  win: 10,
  minNetSol: 0.15,
  minBuys: 3,
  minBuyers: 3,
  minUp: 0.02,
  maxUp: 1.5,
  accel: 1,
  nearHigh: 0.93,
  maxTopShare: 0.6,
  minRq: 1.5,
  maxRq: 70,
  minAge: 5,
  maxAge: 200,
  buySlipBps: 10000,
  firstBuy: 0.03,
  maxStake: 0.03,
  minBuy: 0.01,
  stopGrace: 0,
  stopLoss: 0.12,
  takeProfit1: 0.3,
  partialFrac: 0.5,
  trailArm: 0.3,
  trail: 0.35,
  fadeWin: 12,
  fadeNet: -2,
  maxHold: 2000,
  holdIfUp: 0.5,
  cooldown: 120,
  maxEntries: 2,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.02,
  maxProbes: 1,
  maxMain: 5,
  maxExposure: 6,
};

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
}

interface Pos {
  opened: number;
  peak: number; // best close value seen, SOL
  invested: number; // SOL sent in buys
  lastAddPrice: number;
  lastValue: number;
  leaving: boolean;
  filled: boolean;
  // Stage one done: half the tokens already banked at +takeProfit1.
  banked: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  return Number(vq) / Number(vt);
}

/** Net SOL (buys minus sells) on a tape over the last `w` slots. */
function netFlow(ticks: Tick[], now: number, w: number): number {
  let net = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const t = ticks[i]!;
    if (t.slot <= now - w) break;
    net += t.buy ? t.sol : -t.sol;
  }
  return net;
}

export function makeBot(cfg: Cfg) {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Pos>();
  // Probe round trips: mint -> true once its sell is out.
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  const keep = cfg.win + cfg.fadeWin + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, ticks: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** True when a curve's recent tape shows the entry signature. */
  const entryOk = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < cfg.minRq || rqSol > cfg.maxRq) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < cfg.minAge || age > cfg.maxAge) return false;
    const from = now - cfg.win;
    const mid = now - cfg.win / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const buyers = new Map<string, number>();
    for (const tr of t.ticks) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < cfg.minBuys || buyers.size < cfg.minBuyers) return false;
    if (buySol - sellSol < cfg.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < cfg.minUp || up > cfg.maxUp) return false;
    if (last < high * cfg.nearHigh) return false;
    if (netNew <= 0 || netNew < cfg.accel * netOld) return false;
    let top = 0;
    for (const v of buyers.values()) if (v > top) top = v;
    if (top > cfg.maxTopShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigDump = new Set<Pubkey>();
      const touched = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status === "filled" && !f.client_id.startsWith("_")) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null && e.block_time !== undefined) {
          if (firstTs === null) firstTs = e.block_time;
          if (lastTs === null || e.block_time > lastTs) lastTs = e.block_time;
        }
        if (e.event === "CreateEvent") {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === "TradeEvent") {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.ticks.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          });
          touched.add(e.mint);
          if (!e.is_buy && sol >= 5) bigDump.add(e.mint);
        }
      }
      for (const mint of touched) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.ticks.length && t.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.ticks.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // 1. Exits. Stage one banks half at +takeProfit1; the rest rides the trailing stop.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        if (value > h.peak) h.peak = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        // Stage one: bank half the tokens at the first take-profit, keep riding the rest.
        if (!h.banked && !h.leaving && value >= cost * (1 + cfg.takeProfit1)) {
          if (!pendingByMint.has(mint)) {
            const half = BigInt(Math.floor(tokens * cfg.partialFrac));
            if (half > 0n && orders.length < cap) {
              orders.push({ side: "sell", mint, token_amount: half, max_slippage_bps: 10_000 });
              h.banked = true;
              // The peak now tracks the smaller remaining position.
              h.peak = value * (1 - cfg.partialFrac);
              continue;
            }
          }
        }
        let exit = h.leaving;
        const pastGrace = now - h.opened > cfg.stopGrace;
        if (!exit && pastGrace && value < cost * (1 - cfg.stopLoss)) exit = true;
        if (!exit && h.banked && h.peak >= cost * (1 - cfg.partialFrac) * (1 + cfg.trailArm) && value < h.peak * (1 - cfg.trail)) exit = true;
        if (!exit && !h.banked && h.peak >= cost * (1 + cfg.trailArm) && value < h.peak * (1 - cfg.trail)) exit = true;
        if (!exit && pastGrace && netFlow(t.ticks, now, cfg.fadeWin) < cfg.fadeNet) exit = true;
        if (!exit && bigDump.has(mint)) exit = true;
        if (!exit && now - h.opened > cfg.maxHold && value < cost * (1 + cfg.holdIfUp)) exit = true;
        if (!exit) continue;
        h.leaving = true;
        if (pendingByMint.has(mint)) {
          let sellOut = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === "sell") sellOut = true;
          }
          if (sellOut) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // 2. Probe round trips: sell the probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // 3. Entries (one small buy per position; no pyramiding).
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = cfg.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        if (held.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= cfg.maxEntries || now - t.lastExit < cfg.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entryOk(t, now, rqSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, cfg.firstBuy, cfg.maxExposure - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < cfg.minBuy) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        orders.push({ side: "buy", mint, quote_lamports: lamports, max_slippage_bps: cfg.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, {
          opened: now,
          peak: 0,
          invested: amount,
          lastAddPrice: price,
          lastValue: 0,
          leaving: false,
          filled: false,
          banked: false,
        });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // 4. Pacing probes: keep fills and coins on the pace the bar needs.
      if (probes.size < cfg.maxProbes && slotsLeft > 0 && firstTs !== null && lastTs !== null) {
        const pace = Math.min(1, (lastTs - firstTs) / cfg.paceSecs);
        const needCoins = myCoins.size < Math.ceil(cfg.targetCoins * pace);
        const needFills = myFills < Math.ceil(cfg.targetFills * pace);
        if (needCoins || needFills) {
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= cfg.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            // Only probe curves liquid enough that the probe fits the 1% reserve cap.
            if (Number(curve.real_quote_reserves) / LAMPORTS < cfg.probeSol * 150) continue;
            if (free < cfg.probeSol + 2 * tx) break;
            orders.push({
              side: "buy",
              mint,
              quote_lamports: BigInt(Math.floor(cfg.probeSol * LAMPORTS)),
              max_slippage_bps: cfg.buySlipBps,
            });
            probes.set(mint, false);
            free -= cfg.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
