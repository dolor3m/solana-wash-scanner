import type { TapeTrade } from "./types.ts";

type TokenBal = {
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
};

type AccountKey = { pubkey?: string; signer?: boolean } | string;

type RpcTx = {
  slot?: number;
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    preTokenBalances?: TokenBal[];
    postTokenBalances?: TokenBal[];
  } | null;
  transaction?: {
    message?: { accountKeys?: AccountKey[] };
  };
};

export type OwnerDelta = {
  owner: string;
  tokenDelta: number;
  signer: boolean;
};

export type SwapLeg = {
  signature: string;
  time: number;
  slot: number;
  deltas: OwnerDelta[];
};

function asTx(value: unknown): RpcTx | null {
  if (!value || typeof value !== "object") return null;
  return value as RpcTx;
}

function signersOf(tx: RpcTx): Set<string> {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const out = new Set<string>();
  for (const key of keys) {
    if (typeof key === "string") continue;
    if (key.signer && key.pubkey) out.add(key.pubkey);
  }
  return out;
}

function uiFromRaw(amount: bigint, decimals: number): number {
  const negative = amount < 0n;
  const value = negative ? -amount : amount;
  const scale = 10n ** BigInt(Math.max(0, decimals));
  const whole = value / scale;
  const frac = value % scale;
  const n = Number(whole) + Number(frac) / 10 ** decimals;
  return negative ? -n : n;
}

function deltasForMint(tx: RpcTx, mint: string): Map<string, number> {
  const pre = new Map<string, bigint>();
  const post = new Map<string, bigint>();
  let decimals = 0;

  const absorb = (list: TokenBal[] | undefined, into: Map<string, bigint>) => {
    for (const row of list ?? []) {
      if (row.mint !== mint || !row.owner) continue;
      const raw = row.uiTokenAmount?.amount;
      if (!raw) continue;
      let amount: bigint;
      try {
        amount = BigInt(raw);
      } catch {
        continue;
      }
      into.set(row.owner, (into.get(row.owner) ?? 0n) + amount);
      if (typeof row.uiTokenAmount?.decimals === "number") {
        decimals = row.uiTokenAmount.decimals;
      }
    }
  };

  absorb(tx.meta?.preTokenBalances, pre);
  absorb(tx.meta?.postTokenBalances, post);
  const owners = new Set<string>([...pre.keys(), ...post.keys()]);
  const out = new Map<string, number>();
  for (const owner of owners) {
    const delta = (post.get(owner) ?? 0n) - (pre.get(owner) ?? 0n);
    if (delta === 0n) continue;
    out.set(owner, uiFromRaw(delta, decimals));
  }
  return out;
}

export function extractLeg(
  signature: string,
  value: unknown,
  mint: string,
  exclude: string | readonly string[],
): SwapLeg | null {
  const tx = asTx(value);
  if (!tx?.meta || tx.meta.err) return null;
  if (typeof tx.blockTime !== "number" || typeof tx.slot !== "number") return null;

  const skip = new Set(typeof exclude === "string" ? [exclude] : exclude);
  const signers = signersOf(tx);
  const deltas: OwnerDelta[] = [];
  for (const [owner, tokenDelta] of deltasForMint(tx, mint)) {
    if (skip.has(owner)) continue;
    deltas.push({ owner, tokenDelta, signer: signers.has(owner) });
  }
  if (!deltas.length) return null;
  return { signature, time: tx.blockTime, slot: tx.slot, deltas };
}

function pickTrader(deltas: OwnerDelta[]): OwnerDelta | null {
  const signing = deltas.filter((row) => row.signer);
  if (!signing.length) return null;
  return signing.reduce((best, row) =>
    Math.abs(row.tokenDelta) > Math.abs(best.tokenDelta) ? row : best,
  );
}

export function tradesFromLegs(legs: SwapLeg[], priceUsd: number): TapeTrade[] {
  const trades: TapeTrade[] = [];
  for (const leg of legs) {
    const trader = pickTrader(leg.deltas);
    if (!trader) continue;
    const tokenAmount = Math.abs(trader.tokenDelta);
    const usd = tokenAmount * (priceUsd > 0 ? priceUsd : 0);
    if (priceUsd > 0 && usd < 0.2) continue;
    trades.push({
      signature: leg.signature,
      time: leg.time,
      slot: leg.slot,
      wallet: trader.owner,
      side: trader.tokenDelta > 0 ? "buy" : "sell",
      tokenAmount,
      usd,
    });
  }
  return trades;
}
