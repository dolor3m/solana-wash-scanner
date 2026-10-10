import type {
  Analysis,
  AnalyzeContext,
  Signal,
  TapeTrade,
  Verdict,
  WalletRole,
  WalletRow,
} from "./types.ts";

const MATERIAL_SHARE = 0.04;
const FAST_GAP_SEC = 180;
const TIGHT_SPAN_SEC = 900;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid] ?? null;
  const left = sorted[mid - 1] ?? 0;
  const right = sorted[mid] ?? 0;
  return (left + right) / 2;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function clipTight(amounts: number[]): boolean {
  if (amounts.length < 4) return false;
  const mid = median(amounts);
  if (mid === null || mid <= 0) return false;
  const close = amounts.filter((n) => Math.abs(n - mid) / mid <= 0.12).length;
  return close / amounts.length >= 0.65;
}

function verdictFor(score: number): Verdict {
  if (score >= 75) return "heavy";
  if (score >= 50) return "circular";
  if (score >= 25) return "mixed";
  return "quiet";
}

const TITLES: Record<Verdict, string> = {
  quiet: "Little circular flow",
  mixed: "Some round-trips",
  circular: "Round-trip heavy",
  heavy: "Tape is mostly circular",
};

function roleFor(row: {
  flagged: boolean;
  buys: number;
  sells: number;
}): WalletRole {
  if (row.flagged) return "round-trip";
  if (row.sells === 0 && row.buys > 0) return "buyer";
  if (row.buys === 0 && row.sells > 0) return "seller";
  return "mixed";
}

function buildWallets(trades: TapeTrade[], totalUsd: number): WalletRow[] {
  const grouped = new Map<string, TapeTrade[]>();
  for (const trade of trades) {
    const list = grouped.get(trade.wallet) ?? [];
    list.push(trade);
    grouped.set(trade.wallet, list);
  }

  const rows: WalletRow[] = [];
  for (const [address, list] of grouped) {
    const ordered = [...list].sort((a, b) => a.time - b.time || a.slot - b.slot);
    let buys = 0;
    let sells = 0;
    let buyUsd = 0;
    let sellUsd = 0;
    const gaps: number[] = [];
    let flips = 0;
    for (let i = 0; i < ordered.length; i++) {
      const trade = ordered[i];
      if (!trade) continue;
      if (trade.side === "buy") {
        buys += 1;
        buyUsd += trade.usd;
      } else {
        sells += 1;
        sellUsd += trade.usd;
      }
      const prev = ordered[i - 1];
      if (prev) {
        gaps.push(Math.max(0, trade.time - prev.time));
        if (prev.side !== trade.side) flips += 1;
      }
    }
    const volumeUsd = buyUsd + sellUsd;
    const balanceRatio =
      buys > 0 && sells > 0 ? Math.min(buyUsd, sellUsd) / Math.max(buyUsd, sellUsd) : null;
    const medianGapSec = median(gaps);
    const alternation = ordered.length > 1 ? flips / (ordered.length - 1) : null;
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const span =
      first && last ? Math.max(0, last.time - first.time) : null;
    const material = totalUsd <= 0 ? volumeUsd > 0 : volumeUsd / totalUsd >= MATERIAL_SHARE;
    const fast = medianGapSec !== null && medianGapSec <= FAST_GAP_SEC;
    const tight = span !== null && span <= TIGHT_SPAN_SEC && ordered.length >= 2;
    const twoLeg =
      ordered.length >= 2 &&
      balanceRatio !== null &&
      balanceRatio >= 0.7 &&
      (fast || (span !== null && span <= FAST_GAP_SEC));
    const multi =
      ordered.length >= 3 &&
      balanceRatio !== null &&
      balanceRatio >= 0.55 &&
      (fast || tight || (alternation !== null && alternation >= 0.65 && fast));
    const flagged = material && (twoLeg || multi);
    const reasons: string[] = [];
    if (flagged && balanceRatio !== null) {
      reasons.push(`${Math.round(balanceRatio * 100)}% of buy and sell dollars match`);
    }
    if (flagged && fast && medianGapSec !== null) {
      reasons.push(`median gap ${Math.round(medianGapSec)}s`);
    }
    if (flagged && clipTight(ordered.map((t) => t.usd))) {
      reasons.push("repeated clip size");
    }
    rows.push({
      address,
      buys,
      sells,
      buyUsd,
      sellUsd,
      volumeUsd,
      balanceRatio,
      medianGapSec,
      alternation,
      flagged,
      reasons,
      role: "mixed",
    });
  }

  for (const row of rows) row.role = roleFor(row);
  rows.sort((a, b) => b.volumeUsd - a.volumeUsd);
  return rows;
}

function detailFor(verdict: Verdict, dampened: boolean, lowSample: boolean): string {
  const base =
    verdict === "heavy"
      ? "Most of the sampled volume buys and sells back through the same wallets. That is the shape wash trading leaves on an AMM."
      : verdict === "circular"
        ? "A large share of this sample is inventory-neutral. The same wallets are printing both sides."
        : verdict === "mixed"
          ? "A few wallets round-trip, but they do not dominate the sample. That is not enough on its own to call wash trading."
          : "Buys and sells in this sample mostly come from different wallets. Nothing here looks like a circular tape.";
  const extra: string[] = [];
  if (dampened) {
    extra.push(
      "The score is discounted because this pool is liquid and many wallets traded. Market makers also sit inventory-neutral.",
    );
  }
  if (lowSample) {
    extra.push("The sample is short, so the score is capped.");
  }
  extra.push(
    "This reads one recent slice of the busiest pools. It is a heuristic, not proof.",
  );
  return [base, ...extra].join(" ");
}

export function analyzeTape(trades: TapeTrade[], context: AnalyzeContext): Analysis {
  const ordered = [...trades].sort((a, b) => a.time - b.time || a.slot - b.slot);
  const sampledVolumeUsd = ordered.reduce((sum, trade) => sum + trade.usd, 0);
  const wallets = buildWallets(ordered, sampledVolumeUsd);
  const uniqueWallets = wallets.length;
  const buyCount = ordered.filter((t) => t.side === "buy").length;
  const sellCount = ordered.length - buyCount;
  const circularVolumeUsd = wallets
    .filter((w) => w.flagged)
    .reduce((sum, w) => sum + w.volumeUsd, 0);
  const circularShare = sampledVolumeUsd > 0 ? circularVolumeUsd / sampledVolumeUsd : 0;

  let clipVolume = 0;
  for (const wallet of wallets) {
    if (!wallet.flagged) continue;
    const amounts = ordered.filter((t) => t.wallet === wallet.address).map((t) => t.usd);
    if (clipTight(amounts)) clipVolume += wallet.volumeUsd;
  }
  const clipShare = sampledVolumeUsd > 0 ? clipVolume / sampledVolumeUsd : 0;
  const topFlaggedShare =
    sampledVolumeUsd > 0 ? (wallets.find((w) => w.flagged)?.volumeUsd ?? 0) / sampledVolumeUsd : 0;

  const liquidity = context.liquidityUsd ?? 0;
  const dampened = uniqueWallets >= 30 && liquidity >= 250_000 && circularShare < 0.75;
  const thinBook = !dampened && uniqueWallets <= 12 && uniqueWallets > 0 && circularShare >= 0.3;
  const lowSample = ordered.length < 8;

  let score = circularShare * 64;
  if (clipShare >= 0.2) score += 8;
  if (topFlaggedShare >= 0.45) score += 6;
  if (dampened) score *= 0.62;
  else if (thinBook) score *= 1.12;
  if (lowSample) score = Math.min(score, 40);
  score = clamp(Math.round(score), 0, 100);

  const verdict = verdictFor(score);
  const signals: Signal[] = [];

  if (circularShare >= 0.15 && circularVolumeUsd > 0) {
    signals.push({
      id: "round-trip",
      title: "Round-trip wallets",
      weight: circularShare >= 0.5 ? "strong" : "watch",
      detail: `${Math.round(circularShare * 100)}% of sampled dollars belong to wallets that both buy and sell, with the two sides close in size and close in time.`,
    });
  } else {
    signals.push({
      id: "round-trip",
      title: "Round-trip wallets",
      weight: "note",
      detail: "No material wallet both bought and sold this sample in a tight, balanced loop.",
    });
  }

  if (clipShare >= 0.2) {
    signals.push({
      id: "clips",
      title: "Repeated clip size",
      weight: "watch",
      detail:
        "Flagged wallets keep hitting nearly the same dollar size. Washes often replay one clip. Market makers do this too.",
    });
  }

  if (topFlaggedShare >= 0.45) {
    signals.push({
      id: "concentration",
      title: "One wallet dominates the loop",
      weight: "strong",
      detail: `The largest round-trip wallet is ${Math.round(topFlaggedShare * 100)}% of sampled volume.`,
    });
  }

  if (uniqueWallets > 0 && uniqueWallets <= 8 && ordered.length >= 8) {
    signals.push({
      id: "narrow",
      title: "Very few wallets",
      weight: "watch",
      detail: `Only ${uniqueWallets} wallets appear in this slice. A real market is usually wider than that.`,
    });
  }

  if (dampened) {
    signals.push({
      id: "dampen",
      title: "Liquid pool, many wallets",
      weight: "note",
      detail:
        "Inventory-neutral flow on a deep pool is often a market maker. The score is discounted for that.",
    });
  }

  if (lowSample) {
    signals.push({
      id: "sample",
      title: "Short sample",
      weight: "note",
      detail: `Only ${ordered.length} swaps were scored. A short tape cannot clear a token, and it cannot convict one either.`,
    });
  }

  const turnover =
    context.liquidityUsd && context.liquidityUsd > 0 && context.volume24hUsd
      ? context.volume24hUsd / context.liquidityUsd
      : null;
  if (turnover !== null && turnover >= 5) {
    signals.push({
      id: "turnover",
      title: "Volume is large versus liquidity",
      weight: "watch",
      detail: `24h volume is ${turnover.toFixed(1)}× pool liquidity. That can be real demand or printed volume. It is shown for context and is not added to the score.`,
    });
  }

  return {
    sampledTrades: ordered.length,
    uniqueWallets,
    windowStart: ordered[0]?.time ?? null,
    windowEnd: ordered[ordered.length - 1]?.time ?? null,
    buyCount,
    sellCount,
    sampledVolumeUsd,
    circularVolumeUsd,
    circularShare,
    score,
    verdict,
    verdictTitle: TITLES[verdict],
    verdictDetail: detailFor(verdict, dampened, lowSample),
    dampened,
    thinBook,
    lowSample,
    signals,
    wallets,
    trades: [...ordered].reverse(),
  };
}
