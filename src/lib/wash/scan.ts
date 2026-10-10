import { analyzeTape } from "./detect.ts";
import { extractLeg, tradesFromLegs, type SwapLeg } from "./parse.ts";
import type { ScanReport } from "./types.ts";

const RPC = "https://solana-rpc.publicnode.com";
const DEX = "https://api.dexscreener.com";
const CONCURRENCY = 5;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  info?: { imageUrl?: string };
};

type SigRow = { signature: string; err: unknown; blockTime?: number | null };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error("Market data is rate-limiting. Wait a moment and try again.");
    }
    throw new Error(`Market data request failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

async function rpcCall<T>(method: string, params: unknown[], timeoutMs = 12000): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Solana RPC returned ${res.status}.`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "Solana RPC error.");
  return body.result as T;
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function volumeOf(pair: DexPair): number {
  return pair.volume?.h24 ?? 0;
}

function liquidityOf(pair: DexPair): number {
  return pair.liquidity?.usd ?? 0;
}

function pickSearch(pairs: DexPair[], query: string): DexPair | null {
  const solana = pairs.filter((p) => p.chainId === "solana" && p.pairAddress && p.baseToken?.address);
  const q = query.toLowerCase();
  const exact = solana.filter(
    (p) => p.baseToken?.symbol?.toLowerCase() === q || p.baseToken?.name?.toLowerCase() === q,
  );
  const list = exact.length ? exact : solana;
  if (!list.length) return null;
  return [...list].sort((a, b) => volumeOf(b) - volumeOf(a) || liquidityOf(b) - liquidityOf(a))[0] ?? null;
}

async function resolve(query: string): Promise<{ mint: string; pools: DexPair[] }> {
  if (BASE58.test(query)) {
    const tokenBody = await getJson<{ pairs?: DexPair[] | null }>(
      `${DEX}/latest/dex/tokens/${query}`,
    );
    const pairs = tokenBody.pairs ?? [];
    const asBase = pairs
      .filter((p) => p.chainId === "solana" && p.baseToken?.address === query && p.pairAddress)
      .sort((a, b) => volumeOf(b) - volumeOf(a));
    if (asBase.length) return { mint: query, pools: asBase };
    const asQuote = pairs.some((p) => p.chainId === "solana" && p.quoteToken?.address === query);
    if (asQuote) {
      throw new Error(
        "That address is the quote side of its pools, usually SOL or a stablecoin. Paste the token mint itself.",
      );
    }
    const pairBody = await getJson<{ pair?: DexPair; pairs?: DexPair[] | null }>(
      `${DEX}/latest/dex/pairs/solana/${query}`,
    );
    const fromPair =
      pairBody.pair?.chainId === "solana"
        ? pairBody.pair
        : ((pairBody.pairs ?? []).find((p) => p.chainId === "solana") ?? null);
    if (fromPair?.baseToken?.address && fromPair.pairAddress) {
      return { mint: fromPair.baseToken.address, pools: [fromPair] };
    }
    throw new Error("No Solana pool found for that address.");
  }

  const search = await getJson<{ pairs?: DexPair[] | null }>(
    `${DEX}/latest/dex/search?q=${encodeURIComponent(query)}`,
  );
  const hit = pickSearch(search.pairs ?? [], query);
  if (!hit?.baseToken?.address) throw new Error("No Solana token matched that search.");
  const mint = hit.baseToken.address;
  try {
    const tokenBody = await getJson<{ pairs?: DexPair[] | null }>(
      `${DEX}/latest/dex/tokens/${mint}`,
    );
    const pools = (tokenBody.pairs ?? [])
      .filter((p) => p.chainId === "solana" && p.baseToken?.address === mint && p.pairAddress)
      .sort((a, b) => volumeOf(b) - volumeOf(a));
    if (pools.length) return { mint, pools };
  } catch {
    // The search hit is enough to score one pool.
  }
  return { mint, pools: [hit] };
}

type MintInfo = {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supplyUi: number | null;
  decimals: number | null;
};

async function readMint(mint: string): Promise<MintInfo> {
  const empty: MintInfo = {
    mintAuthority: null,
    freezeAuthority: null,
    supplyUi: null,
    decimals: null,
  };
  try {
    const result = await rpcCall<{
      value?: {
        data?: {
          parsed?: {
            info?: {
              decimals?: number;
              supply?: string;
              mintAuthority?: string | null;
              freezeAuthority?: string | null;
            };
          };
        };
      } | null;
    }>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const info = result?.value?.data?.parsed?.info;
    if (!info) return empty;
    const decimals = typeof info.decimals === "number" ? info.decimals : null;
    let supplyUi: number | null = null;
    if (info.supply && decimals !== null) {
      supplyUi = uiSupply(info.supply, decimals);
    }
    return {
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      supplyUi,
      decimals,
    };
  } catch {
    return empty;
  }
}

function uiSupply(raw: string, decimals: number): number | null {
  try {
    const amount = BigInt(raw);
    const scale = 10n ** BigInt(decimals);
    return Number(amount / scale) + Number(amount % scale) / 10 ** decimals;
  } catch {
    return null;
  }
}

async function fetchTx(signature: string): Promise<unknown | null> {
  const params = [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await rpcCall<unknown | null>("getTransaction", params, 14000);
      if (result) return result;
    } catch {
      // A busy public node sometimes drops a single signature. One retry, then skip.
    }
  }
  return null;
}

export async function runScan(rawQuery: string): Promise<ScanReport> {
  const query = rawQuery.trim();
  if (query.length < 2 || query.length > 64) {
    throw new Error("Enter a mint address or ticker.");
  }

  const { mint, pools: allPools } = await resolve(query);
  const topVolume = volumeOf(allPools[0] ?? {});
  const pools = allPools
    .filter((pool, index) => index === 0 || volumeOf(pool) >= topVolume * 0.2)
    .slice(0, 2);
  const pair = pools[0];
  if (!pair?.pairAddress || !pair.baseToken?.address) {
    throw new Error("That token has no Solana pool to read.");
  }

  const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : 0;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error("The pool has no usable price yet.");
  }

  const exclude = pools.map((pool) => pool.pairAddress).filter((addr): addr is string => !!addr);
  const [mintInfo, sigGroups] = await Promise.all([
    readMint(mint),
    Promise.all(
      pools.map(async (pool) => {
        const rows = await rpcCall<SigRow[]>("getSignaturesForAddress", [
          pool.pairAddress,
          { limit: 40 },
        ]);
        return (rows ?? []).filter((row) => row && !row.err).slice(0, 22);
      }),
    ),
  ]);

  const seen = new Set<string>();
  const signatures: SigRow[] = [];
  for (const group of sigGroups) {
    for (const row of group) {
      if (seen.has(row.signature)) continue;
      seen.add(row.signature);
      signatures.push(row);
      if (signatures.length >= 36) break;
    }
    if (signatures.length >= 36) break;
  }
  if (!signatures.length) throw new Error("Those pools have no recent swaps.");

  const fetched = await mapPool(signatures, CONCURRENCY, async (row) => {
    const tx = await fetchTx(row.signature);
    return { signature: row.signature, tx };
  });

  const legs: SwapLeg[] = [];
  let skippedTxs = 0;
  for (const row of fetched) {
    if (!row.tx) {
      skippedTxs += 1;
      continue;
    }
    const leg = extractLeg(row.signature, row.tx, mint, exclude);
    if (!leg) skippedTxs += 1;
    else legs.push(leg);
  }

  const trades = tradesFromLegs(legs, priceUsd);
  skippedTxs += legs.length - trades.length;

  if (trades.length < 4) {
    throw new Error("Not enough recent swaps came back to score. Try again in a moment.");
  }

  const liquidityUsd = pools.reduce((sum, pool) => sum + (pool.liquidity?.usd ?? 0), 0) || null;
  const volume24hUsd = pools.reduce((sum, pool) => sum + (pool.volume?.h24 ?? 0), 0) || null;
  const analysis = analyzeTape(trades, { liquidityUsd, volume24hUsd });
  const turnover =
    liquidityUsd && liquidityUsd > 0 && volume24hUsd ? volume24hUsd / liquidityUsd : null;
  const dex = [...new Set(pools.map((pool) => pool.dexId).filter(Boolean))].join(" + ") || "dex";

  return {
    ...analysis,
    query,
    mint,
    symbol: pair.baseToken.symbol || "TOKEN",
    name: pair.baseToken.name || "Unknown token",
    imageUrl: pair.info?.imageUrl || null,
    priceUsd,
    liquidityUsd,
    volume24hUsd,
    marketCapUsd: typeof pair.marketCap === "number" ? pair.marketCap : null,
    dex,
    pairAddress: pair.pairAddress,
    pairUrl: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
    quoteSymbol: pair.quoteToken?.symbol || "QUOTE",
    mintAuthority: mintInfo.mintAuthority,
    freezeAuthority: mintInfo.freezeAuthority,
    supplyUi: mintInfo.supplyUi,
    decimals: mintInfo.decimals,
    skippedTxs,
    fetchedTxs: fetched.length,
    turnover,
  };
}
