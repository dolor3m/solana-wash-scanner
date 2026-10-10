import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTape } from "./detect.ts";
import type { TapeTrade } from "./types.ts";

function trade(partial: Pick<TapeTrade, "wallet" | "side" | "usd"> & Partial<TapeTrade>): TapeTrade {
  return {
    signature: partial.signature ?? `${partial.wallet}-${partial.time ?? 0}-${partial.side}`,
    time: partial.time ?? 0,
    slot: partial.slot ?? partial.time ?? 0,
    wallet: partial.wallet,
    side: partial.side,
    tokenAmount: partial.tokenAmount ?? partial.usd,
    usd: partial.usd,
  };
}

test("a fast balanced wallet dominates the score", () => {
  const trades: TapeTrade[] = [];
  for (let i = 0; i < 8; i++) {
    trades.push(
      trade({
        wallet: "WASHER",
        side: i % 2 ? "sell" : "buy",
        usd: 500,
        time: 1_700_000_000 + i * 20,
        slot: 10 + i,
      }),
    );
  }
  trades.push(trade({ wallet: "RETAIL", side: "buy", usd: 40, time: 1_700_000_200, slot: 40 }));
  const report = analyzeTape(trades, { liquidityUsd: 20_000, volume24hUsd: 10_000 });
  assert.equal(report.wallets[0]?.flagged, true);
  assert.ok(report.score >= 75, `expected heavy score, got ${report.score}`);
  assert.equal(report.verdict, "heavy");
});

test("one-way flow scores quiet", () => {
  const trades = Array.from({ length: 12 }, (_, i) =>
    trade({
      wallet: `BUYER_${i}`,
      side: i % 5 === 0 ? "sell" : "buy",
      usd: 100,
      time: 1_700_000_000 + i * 30,
      slot: i,
    }),
  );
  const report = analyzeTape(trades, { liquidityUsd: 80_000, volume24hUsd: 20_000 });
  assert.equal(report.circularShare, 0);
  assert.ok(report.score < 25, `expected quiet score, got ${report.score}`);
});

test("liquid markets discount market-maker flow", () => {
  const trades: TapeTrade[] = [];
  for (let i = 0; i < 8; i++) {
    trades.push(
      trade({
        wallet: "MM",
        side: i % 2 ? "sell" : "buy",
        usd: 200,
        time: 1_700_000_000 + i * 15,
        slot: i,
      }),
    );
  }
  for (let i = 0; i < 30; i++) {
    trades.push(
      trade({
        wallet: `W${i}`,
        side: "buy",
        usd: 100,
        time: 1_700_000_400 + i,
        slot: 100 + i,
      }),
    );
  }
  const raw = analyzeTape(trades, { liquidityUsd: 1_000, volume24hUsd: 1_000 });
  const deep = analyzeTape(trades, { liquidityUsd: 1_000_000, volume24hUsd: 2_000_000 });
  assert.equal(deep.dampened, true);
  assert.ok(deep.score < raw.score);
});

test("two-leg wash is flagged when it is the tape", () => {
  const trades = [
    trade({ wallet: "LOOP", side: "buy", usd: 1000, time: 100, slot: 1 }),
    trade({ wallet: "LOOP", side: "sell", usd: 980, time: 140, slot: 2 }),
    trade({ wallet: "OTHER", side: "buy", usd: 30, time: 150, slot: 3 }),
    trade({ wallet: "OTHER2", side: "sell", usd: 20, time: 160, slot: 4 }),
  ];
  const report = analyzeTape(trades, { liquidityUsd: null, volume24hUsd: null });
  assert.equal(report.wallets.find((w) => w.address === "LOOP")?.flagged, true);
  assert.equal(report.lowSample, true);
  assert.ok(report.score <= 40);
});
