export type Side = "buy" | "sell";

export type TapeTrade = {
  signature: string;
  time: number;
  slot: number;
  wallet: string;
  side: Side;
  tokenAmount: number;
  usd: number;
};

export type WalletRole = "round-trip" | "buyer" | "seller" | "mixed";

export type WalletRow = {
  address: string;
  buys: number;
  sells: number;
  buyUsd: number;
  sellUsd: number;
  volumeUsd: number;
  balanceRatio: number | null;
  medianGapSec: number | null;
  alternation: number | null;
  role: WalletRole;
  flagged: boolean;
  reasons: string[];
};

export type SignalWeight = "note" | "watch" | "strong";

export type Signal = {
  id: string;
  title: string;
  detail: string;
  weight: SignalWeight;
};

export type Verdict = "quiet" | "mixed" | "circular" | "heavy";

export type Analysis = {
  sampledTrades: number;
  uniqueWallets: number;
  windowStart: number | null;
  windowEnd: number | null;
  buyCount: number;
  sellCount: number;
  sampledVolumeUsd: number;
  circularVolumeUsd: number;
  circularShare: number;
  score: number;
  verdict: Verdict;
  verdictTitle: string;
  verdictDetail: string;
  dampened: boolean;
  thinBook: boolean;
  lowSample: boolean;
  signals: Signal[];
  wallets: WalletRow[];
  trades: TapeTrade[];
};

export type ScanReport = Analysis & {
  query: string;
  mint: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  dex: string;
  pairAddress: string;
  pairUrl: string;
  quoteSymbol: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supplyUi: number | null;
  decimals: number | null;
  skippedTxs: number;
  fetchedTxs: number;
  turnover: number | null;
};

export type AnalyzeContext = {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
};
