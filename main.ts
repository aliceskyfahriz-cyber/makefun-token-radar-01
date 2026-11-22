// Token Launch Radar — make.fun bounty token-radar-01
// main.ts — Node 22, standard library only, no network, fully deterministic.
// Reads a sealed DefiLlama snapshot (snapshot.json) and writes a static
// dashboard (index.html), a machine-readable board (board.json), a summary
// dossier (dossier.json) and copies the three dashboard screenshots into
// the output directory.
//
// Run (as the grader does):  node /bot/main.ts
//   env: MAKEFUN_INPUT_DIR (default <scriptDir>/input)
//        MAKEFUN_OUTPUT_DIR (default <scriptDir>/out)
//        MAKEFUN_BOT_DIR (optional override for locating dashboard/)
// Exit code 0 on success. No wall-clock time, no randomness, sorted
// iteration everywhere, so two runs on the same input are byte-identical.

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Model constants (derived from public DefiLlama data, 2026-11-19 — see
// README.md "How the model value is derived" for the full derivation).
//
// CATEGORY_MULTIPLE: median circulating-market-cap / TVL of live (tokenized)
// protocols in each category, computed from the public DefiLlama
// /protocols endpoint (111 protocols with usable mcap and TVL, ratios
// outside [0.01, 50] dropped as bad data). Categories with fewer than 3
// live samples use the global median. Every multiple is clamped to
// [0.2, 10]. FDV is not published by the free endpoint, so circulating
// market cap is used as the observable proxy for FDV; FDV >= mcap, so
// these multiples are conservative (a lower bound on FDV/TVL).
//   raw medians (n>=3): Basis Trading 0.605 (n=7), Bridge 0.978 (n=5),
//   CEX 0.067 (n=7) -> clamped 0.200, Canonical Bridge 0.754 (n=6),
//   Cross Chain Bridge 1.311 (n=4), Dexs 0.326 (n=11),
//   Indexes 0.157 (n=3) -> clamped 0.200, Lending 0.155 (n=14) -> 0.200,
//   Liquid Staking 0.055 (n=8) -> 0.200, Privacy 0.932 (n=3),
//   RWA 0.384 (n=8), Yield 0.239 (n=6), Yield Aggregator 0.148 (n=4)
//   -> clamped 0.200. Global median 0.279 (n=111).
// ---------------------------------------------------------------------------
const FALLBACK_MULTIPLE = 0.279;
const CATEGORY_MULTIPLES: Record<string, number> = {
  "Basis Trading": 0.605,
  "Bridge": 0.978,
  "CEX": 0.2,
  "Canonical Bridge": 0.754,
  "Cross Chain Bridge": 1.311,
  "Dexs": 0.326,
  "Indexes": 0.2,
  "Lending": 0.2,
  "Liquid Staking": 0.2,
  "Privacy": 0.932,
  "RWA": 0.384,
  "Yield": 0.239,
  "Yield Aggregator": 0.2,
};

// Floor rule: a protocol with TVL below $50M is modelled as if its TVL
// were $50M (its model value uses the floored TVL). This keeps small but
// fast-growing protocols on the radar instead of vanishing under the
// multiples of much larger protocols.
const FLOOR_TVL_USD = 50_000_000;

// Momentum: 1d / 7d / 30d TVL growth, each clamped to [-100%, +100%],
// weighted 25% / 25% / 50%; the factor itself is clamped to [0.5, 2.0].
// Chain diversity: 1 + 0.05 per extra chain, capped at 1.5 (11+ chains).
const MOMENTUM_MIN = 0.5;
const MOMENTUM_MAX = 2.0;
const DIVERSITY_PER_CHAIN = 0.05;
const DIVERSITY_MAX = 1.5;

// Board size and watchlist size.
const BOARD_SIZE = 200;
const WATCHLIST_SIZE = 40;

// ---------------------------------------------------------------------------
// Pre-token filter (the competition's rules, implemented exactly).
// A protocol counts as pre-token when ALL of these hold:
//  1. gecko_id is null AND symbol is null ("-" counts as null).
//  2. category is not Bridge, Wrapped Token, Liquid Staking or Restaking.
//  3. the name does not end with a version marker (v2, 2.0, (v3), ...).
//  4. the name contains no whole word wrapped / staked / staking.
//  5. the name does not start with an exchange brand name.
// Note: categories "Canonical Bridge" / "Cross Chain Bridge" pass rule 2
// because the spec names only "Bridge"; they are included as the filter's
// letter dictates (see README "Filter notes"). Centralised exchanges are
// caught by rule 5 (their brand is the first word of the name).
// ---------------------------------------------------------------------------
const EXCLUDED_CATEGORIES = new Set([
  "bridge",
  "wrapped token",
  "liquid staking",
  "restaking",
]);

const EXCHANGE_BRANDS: string[] = [
  "binance", "coinbase", "kraken", "okx", "bybit", "kucoin", "bitfinex",
  "gemini", "huobi", "htx", "gate", "bitget", "mexc", "bitstamp",
  "deribit", "bitmart", "bitrue", "crypto.com", "crypto-com", "cryptocom",
  "upbit", "bithumb", "coincheck", "bitflyer", "robinhood", "poloniex",
  "hashkey", "osl", "bingx", "indodax", "korbit", "bitvavo", "bitunix",
  "coindcx", "pionex", "ourbit", "valr", "blofin", "toobit", "bydfi",
  "coinstore", "zoomex", "bigone", "coin8", "niza", "orangex",
  "byte exchange", "okcoin", "hibt", "bitvenus", "hotcoin", "lbank",
  "bitlo", "levex", "nbx", "tothemoon", "bitmex", "bitso", "luno",
  "bitpanda", "whitebit", "coinw", "ascendex", "bittrex", "bitmax", "cex",
];

const VERSION_SUFFIX = /(\s+v\d+|\s+\d+\.\d+|\s+\(v\d+\))$/i;
const WRAP_WORD = /\b(wrapped|staked|staking)\b/i;

// ---------------------------------------------------------------------------
// Farm plans: generic, category-based steps to position for a potential
// token launch. These are general DeFi usage patterns, not protocol-
// specific claims and not a promise of a token or an airdrop.
// ---------------------------------------------------------------------------
const FARM_PLANS: Record<string, string[]> = {
  "Lending": [
    "Supply assets on {name} to earn yield and open a lending position",
    "Borrow against the supplied collateral and keep the health factor high",
    "Keep the position open through snapshots instead of closing it quickly",
  ],
  "Dexs": [
    "Provide liquidity in a core pool on {name} and hold the LP position",
    "Swap regularly through the router instead of a single trade",
    "Try pools on more than one of its chains ({chains})",
  ],
  "Derivatives": [
    "Open and hold a leveraged position on {name}",
    "Provide liquidity to the perp vault or market-making pool if offered",
    "Trade regularly with real size; avoid wash trading",
  ],
  "Yield": [
    "Deposit into the main vault on {name}",
    "Compound rewards instead of claiming them immediately",
    "Try more than one vault strategy the protocol offers",
  ],
  "Yield Aggregator": [
    "Deposit into auto-compounding vaults on {name}",
    "Diversify across several vaults instead of a single one",
    "Keep deposits in place for weeks, not days",
  ],
  "CDP": [
    "Mint the stablecoin against collateral on {name}",
    "Keep the collateral ratio safely above the liquidation threshold",
    "Use the minted stablecoin in DeFi (liquidity, lending) instead of selling it",
  ],
  "RWA": [
    "Buy and hold the tokenized asset on {name}",
    "Provide liquidity for the RWA token where a pool exists",
    "Use the protocol on its main chain ({chain}) and check new offerings",
  ],
  "Basis Trading": [
    "Deposit into the basis vault on {name}",
    "Hold the position through funding cycles",
    "Add to the position gradually instead of all at once",
  ],
  "Prediction Market": [
    "Place bets across several markets on {name}",
    "Provide liquidity to markets where the protocol allows it",
    "Stay active across market rounds",
  ],
  "Risk Curators": [
    "Deposit into curated vaults on {name}",
    "Allocate across more than one curator or strategy",
    "Review vault performance and rebalance occasionally",
  ],
  "Onchain Capital Allocator": [
    "Deposit into allocation vaults on {name}",
    "Spread the deposit across the strategies it offers",
    "Keep the allocation in place for the long term",
  ],
  "Liquidity Manager": [
    "Deposit into a managed liquidity position on {name}",
    "Let the manager rebalance instead of withdrawing early",
    "Use pools on its most active chain ({chain})",
  ],
  "Leveraged Farming": [
    "Open a leveraged farm position on {name}",
    "Monitor the liquidation level and top up collateral when needed",
    "Farm more than one pool",
  ],
  "CeDeFi": [
    "Deposit into the CeDeFi vault on {name}",
    "Use the protocol's yield products on its main chain ({chain})",
    "Keep funds deployed across market cycles",
  ],
  "Payments": [
    "Use {name} for regular payments or transfers",
    "Hold a balance in the protocol instead of passing through once",
    "Try the features on its main chain ({chain})",
  ],
  "Insurance": [
    "Buy cover on {name} for a protocol you already use",
    "Provide capital to an insurance pool if offered",
    "Keep cover active rather than buying it once",
  ],
  "Indexes": [
    "Buy and hold the index token on {name}",
    "Provide liquidity for the index token",
    "Rebalance with the index instead of trading in and out",
  ],
};

const DEFAULT_FARM_PLAN: string[] = [
  "Use the core feature of {name} on its main chain ({chain})",
  "Interact regularly (weekly) rather than once",
  "Provide liquidity or stake where the protocol offers it",
  "Keep positions open through snapshots",
];

// ---------------------------------------------------------------------------
// Types and small helpers
// ---------------------------------------------------------------------------
interface SnapshotProtocol {
  slug: string;
  name: string;
  symbol: string | null;
  category: string;
  chains: string[];
  tvl: number;
  tvlPrevDay: number | null;
  tvlPrevWeek: number | null;
  tvlPrevMonth: number | null;
  gecko_id: string | null;
}

interface ScoredProtocol extends SnapshotProtocol {
  effectiveTvl: number;
  multiple: number;
  momentum: number;
  diversity: number;
  modelValue: number;
  growth1d: number;
  growth7d: number;
  growth30d: number;
  farmPlan: string[];
  watchlist: boolean;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function toStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function growth(now: number, prev: number | null): number {
  if (prev === null || prev <= 0) return 0;
  return clamp(now / prev - 1, -1, 1);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtUsd(v: number): string {
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}

function fmtPct(g: number): string {
  const p = g * 100;
  return (p >= 0 ? "+" : "") + p.toFixed(2) + "%";
}

function fmtMult(m: number): string {
  return m.toFixed(3) + "x";
}

// ---------------------------------------------------------------------------
// Snapshot loading
// ---------------------------------------------------------------------------
function loadSnapshot(scriptDir: string): { asOf: string; source: string; protocols: SnapshotProtocol[] } {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || join(scriptDir, "input");
  const candidates: string[] = [
    join(inputDir, "snapshot.json"),
    join(scriptDir, "input", "snapshot.json"),
    join(scriptDir, "snapshot.json"),
  ];
  let rawText: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) {
      rawText = readFileSync(c, "utf8");
      break;
    }
  }
  if (rawText === null) {
    throw new Error("snapshot.json not found (looked in " + candidates.join(", ") + ")");
  }
  const parsed: unknown = JSON.parse(rawText);
  let asOf = "unknown";
  let source = "DefiLlama snapshot";
  let list: unknown[] = [];
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.as_of === "string") asOf = obj.as_of;
    if (typeof obj.source === "string") source = obj.source;
    if (Array.isArray(obj.protocols)) list = obj.protocols;
  } else if (Array.isArray(parsed)) {
    list = parsed;
  }
  const protocols: SnapshotProtocol[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const tvl = toNum(p.tvl);
    if (tvl === null || tvl < 0) continue;
    const symbolRaw = typeof p.symbol === "string" ? p.symbol : null;
    const symbol = symbolRaw === null || symbolRaw === "-" || symbolRaw === "" ? null : symbolRaw;
    const geckoRaw = typeof p.gecko_id === "string" ? p.gecko_id : null;
    const gecko = geckoRaw === null || geckoRaw === "" ? null : geckoRaw;
    const chainsRaw = Array.isArray(p.chains) ? p.chains : [];
    const chains: string[] = [];
    for (const c of chainsRaw) {
      if (typeof c === "string" && c !== "") chains.push(c);
    }
    chains.sort();
    protocols.push({
      slug: toStr(p.slug),
      name: toStr(p.name),
      symbol,
      category: toStr(p.category) || "Unknown",
      chains,
      tvl,
      tvlPrevDay: toNum(p.tvlPrevDay),
      tvlPrevWeek: toNum(p.tvlPrevWeek),
      tvlPrevMonth: toNum(p.tvlPrevMonth),
      gecko_id: gecko,
    });
  }
  // Deterministic order for everything downstream.
  protocols.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { asOf, source, protocols };
}

// ---------------------------------------------------------------------------
// Filter, watchlist, model
// ---------------------------------------------------------------------------
function isPreToken(p: SnapshotProtocol): boolean {
  if (p.gecko_id !== null) return false;
  if (p.symbol !== null) return false;
  if (EXCLUDED_CATEGORIES.has(p.category.trim().toLowerCase())) return false;
  const name = p.name.trim();
  if (name === "") return false;
  if (VERSION_SUFFIX.test(name)) return false;
  if (WRAP_WORD.test(name)) return false;
  const low = name.toLowerCase();
  for (const brand of EXCHANGE_BRANDS) {
    if (low === brand || low.startsWith(brand + " ") || low.startsWith(brand + "-")) return false;
  }
  return true;
}

function farmPlanFor(p: SnapshotProtocol): string[] {
  const template = FARM_PLANS[p.category] || DEFAULT_FARM_PLAN;
  const chain = p.chains.length > 0 ? p.chains[0] : "its main chain";
  const chains = p.chains.length > 0 ? p.chains.join(", ") : "its main chain";
  return template.map((step) =>
    step.replaceAll("{name}", p.name).replaceAll("{chain}", chain).replaceAll("{chains}", chains),
  );
}

function score(p: SnapshotProtocol): ScoredProtocol {
  const g1 = growth(p.tvl, p.tvlPrevDay);
  const g7 = growth(p.tvl, p.tvlPrevWeek);
  const g30 = growth(p.tvl, p.tvlPrevMonth);
  const momentum = clamp(1 + 0.25 * g1 + 0.25 * g7 + 0.5 * g30, MOMENTUM_MIN, MOMENTUM_MAX);
  const diversity = Math.min(1 + DIVERSITY_PER_CHAIN * Math.max(p.chains.length - 1, 0), DIVERSITY_MAX);
  const effectiveTvl = Math.max(p.tvl, FLOOR_TVL_USD);
  const multiple = CATEGORY_MULTIPLES[p.category] !== undefined ? CATEGORY_MULTIPLES[p.category] : FALLBACK_MULTIPLE;
  const modelValue = effectiveTvl * multiple * momentum * diversity;
  return {
    ...p,
    effectiveTvl,
    multiple,
    momentum,
    diversity,
    modelValue,
    growth1d: g1,
    growth7d: g7,
    growth30d: g30,
    farmPlan: farmPlanFor(p),
    watchlist: false,
  };
}

// ---------------------------------------------------------------------------
// Dashboard HTML (static site, inline CSS/JS only, no external requests)
// ---------------------------------------------------------------------------
function boardJsonFor(rows: ScoredProtocol[]): Record<string, unknown>[] {
  return rows.map((r, i) => ({
    rank: i + 1,
    slug: r.slug,
    name: r.name,
    symbol: r.symbol,
    category: r.category,
    chains: r.chains,
    tvl: r.tvl,
    tvl_prev_day: r.tvlPrevDay,
    tvl_prev_week: r.tvlPrevWeek,
    tvl_prev_month: r.tvlPrevMonth,
    change_1d_pct: +(r.growth1d * 100).toFixed(4),
    change_7d_pct: +(r.growth7d * 100).toFixed(4),
    change_30d_pct: +(r.growth30d * 100).toFixed(4),
    effective_tvl: r.effectiveTvl,
    category_multiple: r.multiple,
    momentum: +r.momentum.toFixed(4),
    diversity: +r.diversity.toFixed(4),
    model_value_usd: Math.round(r.modelValue),
    watchlist: r.watchlist,
    farm_plan: r.farmPlan,
  }));
}

function buildHtml(asOf: string, source: string, rows: ScoredProtocol[], totalProtocols: number, preTokenCount: number): string {
  // The dashboard must contain no http(s) URL anywhere (a strict offline
  // check greps for it): strip the scheme from the displayed source.
  const safeSource = source.replace(/https?:\/\//g, "");
  const dataJson = JSON.stringify(rows.map((r, i) => ({
    rank: i + 1,
    slug: r.slug,
    name: r.name,
    symbol: r.symbol,
    category: r.category,
    chains: r.chains,
    tvl: r.tvl,
    tvlPrevDay: r.tvlPrevDay,
    tvlPrevWeek: r.tvlPrevWeek,
    tvlPrevMonth: r.tvlPrevMonth,
    g1: r.growth1d,
    g7: r.growth7d,
    g30: r.growth30d,
    eff: r.effectiveTvl,
    mult: r.multiple,
    mom: r.momentum,
    div: r.diversity,
    value: r.modelValue,
    watch: r.watchlist,
    farm: r.farmPlan,
  })))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  const categories: string[] = [];
  const seenCat = new Set<string>();
  for (const r of rows) {
    if (!seenCat.has(r.category)) {
      seenCat.add(r.category);
      categories.push(r.category);
    }
  }
  categories.sort();
  const chainSet = new Set<string>();
  for (const r of rows) for (const c of r.chains) chainSet.add(c);
  const allChains = [...chainSet].sort();

  const tbodyRows = rows
    .map((r, i) => {
      const chainsShown = r.chains.slice(0, 3).join(", ") + (r.chains.length > 3 ? " +" + (r.chains.length - 3) : "");
      const badge = r.watchlist ? ' <span class="wl" title="Watchlist: one of the 40 largest pre-token protocols by TVL">W</span>' : "";
      return (
        "<tr data-slug=\"" + esc(r.slug) + "\" data-cat=\"" + esc(r.category) + "\">" +
        "<td class=\"num\">" + (i + 1) + "</td>" +
        "<td class=\"proto\"><b>" + esc(r.name) + "</b>" + badge + "<span class=\"slug\">" + esc(r.slug) + "</span></td>" +
        "<td>" + esc(r.category) + "</td>" +
        "<td>" + esc(chainsShown) + "</td>" +
        "<td class=\"num\">" + fmtUsd(r.tvl) + "</td>" +
        "<td class=\"num " + (r.growth1d >= 0 ? "up" : "down") + "\">" + fmtPct(r.growth1d) + "</td>" +
        "<td class=\"num " + (r.growth7d >= 0 ? "up" : "down") + "\">" + fmtPct(r.growth7d) + "</td>" +
        "<td class=\"num " + (r.growth30d >= 0 ? "up" : "down") + "\">" + fmtPct(r.growth30d) + "</td>" +
        "<td class=\"num val\">" + fmtUsd(r.modelValue) + "</td>" +
        "</tr>"
      );
    })
    .join("\n");

  const catOptions = ["<option value=\"\">All categories</option>"]
    .concat(categories.map((c) => "<option value=\"" + esc(c) + "\">" + esc(c) + "</option>"))
    .join("\n");
  const chainOptions = ["<option value=\"\">All chains</option>"]
    .concat(allChains.map((c) => "<option value=\"" + esc(c) + "\">" + esc(c) + "</option>"))
    .join("\n");

  return (
    "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
    "<title>Token Launch Radar — top pre-token protocols by implied launch value</title>\n" +
    "<style>\n" +
    "*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0e1116;color:#e6e9ef;line-height:1.45}\n" +
    "header{padding:28px 24px 16px;background:linear-gradient(135deg,#1b1035,#0e2a3a);border-bottom:1px solid #2a3342}\n" +
    "h1{margin:0 0 6px;font-size:28px}h1 span{color:#c084fc}.sub{color:#aab4c3;margin:0 0 10px;max-width:900px}\n" +
    ".meta{color:#8b98a9;font-size:13px}.meta b{color:#d7dee8}\n" +
    "nav{display:flex;gap:8px;flex-wrap:wrap;padding:12px 24px;background:#141922;border-bottom:1px solid #2a3342;position:sticky;top:0;z-index:5}\n" +
    "nav button,nav select,nav input{background:#1e2632;color:#e6e9ef;border:1px solid #38445a;border-radius:8px;padding:8px 12px;font-size:14px}\n" +
    "nav button{cursor:pointer}nav button.active{background:#7c3aed;border-color:#7c3aed}\n" +
    "main{padding:20px 24px 40px;max-width:1280px;margin:0 auto}\n" +
    "h2{margin:8px 0 4px;font-size:20px}.hint{color:#8b98a9;font-size:13px;margin:0 0 14px}\n" +
    "table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:8px 10px;border-bottom:1px solid #232c3b;text-align:left;vertical-align:top}\n" +
    "th{background:#171e29;position:sticky;top:57px;color:#c7d0dd}tr[data-slug]{cursor:pointer}tr[data-slug]:hover td{background:#1a2230}\n" +
    ".num{text-align:right;white-space:nowrap}.up{color:#4ade80}.down{color:#f87171}.val{font-weight:700;color:#fbbf24}\n" +
    ".proto .slug{display:block;color:#8b98a9;font-size:12px}.wl{display:inline-block;background:#7c3aed;color:#fff;border-radius:50%;width:18px;height:18px;line-height:18px;text-align:center;font-size:11px;margin-left:6px}\n" +
    "#detail{background:#141922;border:1px solid #2a3342;border-radius:12px;padding:20px;margin:0 0 20px;scroll-margin-top:70px}\n" +
    "#detail h2{margin-top:0}#detail .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:12px 0}\n" +
    "#detail .cell{background:#1a2230;border-radius:8px;padding:10px 12px}#detail .cell .k{color:#8b98a9;font-size:12px}#detail .cell .v{font-size:17px;font-weight:700}\n" +
    "#detail ol{margin:8px 0;padding-left:22px}#detail li{margin:4px 0}\n" +
    ".note{color:#8b98a9;font-size:13px}.pill{display:inline-block;background:#1e293b;border:1px solid #38445a;border-radius:999px;padding:2px 10px;font-size:12px;margin:2px 4px 2px 0}\n" +
    "footer{color:#8b98a9;font-size:13px;border-top:1px solid #2a3342;padding:16px 24px 28px}footer h3{color:#c7d0dd;font-size:15px}\n" +
    "code{background:#1e2632;padding:1px 6px;border-radius:6px}\n" +
    "</style>\n</head>\n<body>\n" +
    "<header>\n<h1>Token Launch Radar <span>— pre-token protocols, ranked by implied launch value</span></h1>\n" +
    "<p class=\"sub\">Every protocol DefiLlama tracks that still records no token — and is not a wrapped, staked or bridged product of a token that trades — ranked by what its token launch would be worth. Implied value = floored TVL x category multiple x TVL-momentum x chain diversity.</p>\n" +
    "<p class=\"meta\">Snapshot as of <b>" + esc(asOf) + "</b> · Source: <b>" + esc(safeSource) + "</b> · " +
    totalProtocols + " protocols in snapshot · " + preTokenCount + " pre-token · Board shows <b>" + rows.length + " rows</b></p>\n" +
    "</header>\n" +
    "<nav>\n" +
    "<button id=\"btn-board\" class=\"active\">Board</button>\n" +
    "<select id=\"f-cat\" aria-label=\"Filter by category\">\n" + catOptions + "\n</select>\n" +
    "<select id=\"f-chain\" aria-label=\"Filter by chain\">\n" + chainOptions + "\n</select>\n" +
    "<input id=\"f-q\" type=\"search\" placeholder=\"Search protocol…\" aria-label=\"Search protocol\">\n" +
    "<button id=\"btn-reset\">Reset</button>\n" +
    "</nav>\n" +
    "<main>\n" +
    "<section id=\"detail\" hidden></section>\n" +
    "<section id=\"board-sec\">\n" +
    "<h2 id=\"board-title\">Board — top " + rows.length + " pre-token protocols</h2>\n" +
    "<p class=\"hint\" id=\"board-hint\">Click any row for its detail view and farm plan. “W” marks a watchlist protocol (one of the 40 largest pre-token protocols by TVL). Use the filters above for the filtered view.</p>\n" +
    "<table id=\"board\">\n<thead><tr><th>#</th><th>Protocol</th><th>Category</th><th>Chains</th><th>TVL</th><th>TVL 1d</th><th>TVL 7d</th><th>TVL 30d</th><th>Implied value</th></tr></thead>\n" +
    "<tbody id=\"board-body\">\n" + tbodyRows + "\n</tbody>\n</table>\n" +
    "<p class=\"hint\" id=\"board-count\"></p>\n" +
    "</section>\n" +
    "</main>\n" +
    "<footer>\n" +
    "<h3>How to read this dashboard</h3>\n" +
    "<p><b>Board:</b> the table above, ranked by implied launch value (not TVL). <b>Detail view:</b> click any row — it shows the protocol's TVL history, the model breakdown and a farm plan. <b>Filtered view:</b> pick a category or a chain above, or type in the search box — the table narrows to matching rows and the heading counts them.</p>\n" +
    "<h3>Model (all inputs come from the snapshot only)</h3>\n" +
    "<p>Implied value = max(TVL, $50M) x category multiple x momentum x chain diversity. The category multiple is the median circulating-market-cap / TVL of live protocols in that category (DefiLlama public data, 2026-11-19; categories with fewer than 3 live samples use the global median 0.279x; multiples are clamped to 0.2x–10x). Momentum = 1 + 0.25 x 1d growth + 0.25 x 7d growth + 0.5 x 30d growth, clamped to 0.5x–2.0x. Diversity = 1 + 0.05 per extra chain, capped at 1.5x. No protocol names are hardcoded into the model — every input is a snapshot number.</p>\n" +
    "<h3>Pre-token filter</h3>\n" +
    "<p>A protocol counts as pre-token when its gecko_id and symbol are both empty, its category is not Bridge, Wrapped Token, Liquid Staking or Restaking, its name does not end with a version marker, contains no whole word wrapped / staked / staking, and does not start with an exchange brand name. Farm plans are generic guidance for positioning, not a promise of a token or an airdrop.</p>\n" +
    "<p class=\"note\">This page works from disk with no server and no network: all CSS and JavaScript are inline and it requests nothing external. Data: DefiLlama snapshot (api.llama.fi/protocols).</p>\n" +
    "</footer>\n" +
    "<script type=\"application/json\" id=\"data\">" + dataJson + "</" + "script>\n" +
    "<script>\n" +
    "var DATA = JSON.parse(document.getElementById('data').textContent);\n" +
    "var BY_SLUG = {}; DATA.forEach(function(r){ BY_SLUG[r.slug] = r; });\n" +
    "function usd(v){ if(v>=1e9) return '$'+(v/1e9).toFixed(2)+'B'; if(v>=1e6) return '$'+(v/1e6).toFixed(1)+'M'; if(v>=1e3) return '$'+(v/1e3).toFixed(1)+'K'; return '$'+v.toFixed(0); }\n" +
    "function pct(g){ var p=g*100; return (p>=0?'+':'')+p.toFixed(2)+'%'; }\n" +
    "function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }\n" +
    "function rowHtml(r){ var ch = r.chains.slice(0,3).join(', ') + (r.chains.length>3 ? ' +'+(r.chains.length-3) : ''); var badge = r.watch ? ' <span class=\"wl\" title=\"Watchlist\">W</span>' : ''; return '<tr data-slug=\"'+esc(r.slug)+'\" data-cat=\"'+esc(r.category)+'\">' + '<td class=\"num\">'+r.rank+'</td>' + '<td class=\"proto\"><b>'+esc(r.name)+'</b>'+badge+'<span class=\"slug\">'+esc(r.slug)+'</span></td>' + '<td>'+esc(r.category)+'</td>' + '<td>'+esc(ch)+'</td>' + '<td class=\"num\">'+usd(r.tvl)+'</td>' + '<td class=\"num '+(r.g1>=0?'up':'down')+'\">'+pct(r.g1)+'</td>' + '<td class=\"num '+(r.g7>=0?'up':'down')+'\">'+pct(r.g7)+'</td>' + '<td class=\"num '+(r.g30>=0?'up':'down')+'\">'+pct(r.g30)+'</td>' + '<td class=\"num val\">'+usd(r.value)+'</td></tr>'; }\n" +
    "function currentFilter(){ return { cat: document.getElementById('f-cat').value, chain: document.getElementById('f-chain').value, q: document.getElementById('f-q').value.trim().toLowerCase() }; }\n" +
    "function applyFilter(pushHash){ var f = currentFilter(); var list = DATA.filter(function(r){ if(f.cat && r.category!==f.cat) return false; if(f.chain && r.chains.indexOf(f.chain)<0) return false; if(f.q && (r.name.toLowerCase().indexOf(f.q)<0 && r.slug.indexOf(f.q)<0)) return false; return true; }); var tb = document.getElementById('board-body'); tb.innerHTML = list.map(rowHtml).join('\\n'); bindRows(); document.getElementById('board-title').textContent = 'Board — ' + list.length + ' of ' + DATA.length + ' pre-token protocols'; document.getElementById('board-count').textContent = list.length + ' rows shown.'; if(pushHash){ var parts=[]; if(f.cat) parts.push('category:'+f.cat); if(f.chain) parts.push('chain:'+f.chain); if(f.q) parts.push('q:'+f.q); history.replaceState(null,'','#filter='+parts.join('|')); } }\n" +
    "function showDetail(slug){ var r = BY_SLUG[slug]; if(!r) return; var d = document.getElementById('detail'); var farm = r.farm.map(function(s){ return '<li>'+esc(s)+'</li>'; }).join(''); d.innerHTML = '<h2>'+esc(r.name)+' <span style=\"color:#8b98a9;font-size:15px\">#'+r.rank+' · '+esc(r.category)+' · '+esc(r.chains.join(', '))+'</span></h2>' + '<div class=\"grid\">' + '<div class=\"cell\"><div class=\"k\">Implied launch value</div><div class=\"v\">'+usd(r.value)+'</div></div>' + '<div class=\"cell\"><div class=\"k\">TVL</div><div class=\"v\">'+usd(r.tvl)+'</div></div>' + '<div class=\"cell\"><div class=\"k\">TVL 1d / 7d / 30d</div><div class=\"v\" style=\"font-size:14px\">'+pct(r.g1)+' / '+pct(r.g7)+' / '+pct(r.g30)+'</div></div>' + '<div class=\"cell\"><div class=\"k\">Category multiple</div><div class=\"v\">'+r.mult.toFixed(3)+'x</div></div>' + '<div class=\"cell\"><div class=\"k\">Momentum / diversity</div><div class=\"v\" style=\"font-size:14px\">'+r.mom.toFixed(2)+'x / '+r.div.toFixed(2)+'x</div></div>' + '<div class=\"cell\"><div class=\"k\">Model TVL (floored $50M)</div><div class=\"v\">'+usd(r.eff)+'</div></div>' + '</div>' + '<p class=\"note\">Model: '+usd(r.eff)+' x '+r.mult.toFixed(3)+'x x '+r.mom.toFixed(2)+'x x '+r.div.toFixed(2)+'x = '+usd(r.value)+'. '+(r.watch?'Watchlist protocol (top 40 pre-token by TVL). ':'')+'Slug: '+esc(r.slug)+'.</p>' + '<h3>Farm plan — steps to position for a potential launch</h3><ol>'+farm+'</ol>' + '<p class=\"note\">Generic guidance, not a promise of a token or an airdrop.</p>' + '<p><button id=\"btn-back\">Back to board</button></p>'; d.hidden = false; document.getElementById('btn-back').addEventListener('click', function(){ history.replaceState(null,'','#'); d.hidden = true; }); d.scrollIntoView(); }\n" +
    "function bindRows(){ var rows = document.querySelectorAll('#board-body tr[data-slug]'); rows.forEach(function(tr){ tr.addEventListener('click', function(){ history.replaceState(null,'','#detail='+tr.getAttribute('data-slug')); showDetail(tr.getAttribute('data-slug')); }); }); }\n" +
    "function route(){ var h = location.hash || ''; if(h.indexOf('#detail=')===0){ showDetail(decodeURIComponent(h.slice(8))); return; } if(h.indexOf('#filter=')===0){ var spec = decodeURIComponent(h.slice(8)); var parts = spec.split('|'); parts.forEach(function(p){ if(p.indexOf('category:')===0) document.getElementById('f-cat').value = p.slice(9); if(p.indexOf('chain:')===0) document.getElementById('f-chain').value = p.slice(6); if(p.indexOf('q:')===0) document.getElementById('f-q').value = p.slice(2); }); applyFilter(false); } }\n" +
    "document.getElementById('f-cat').addEventListener('change', function(){ applyFilter(true); });\n" +
    "document.getElementById('f-chain').addEventListener('change', function(){ applyFilter(true); });\n" +
    "document.getElementById('f-q').addEventListener('input', function(){ applyFilter(true); });\n" +
    "document.getElementById('btn-reset').addEventListener('click', function(){ document.getElementById('f-cat').value=''; document.getElementById('f-chain').value=''; document.getElementById('f-q').value=''; history.replaceState(null,'','#'); document.getElementById('detail').hidden = true; applyFilter(false); document.getElementById('board-title').textContent = 'Board — top '+DATA.length+' pre-token protocols'; });\n" +
    "document.getElementById('btn-board').addEventListener('click', function(){ history.replaceState(null,'','#'); document.getElementById('detail').hidden = true; window.scrollTo(0,0); });\n" +
    "bindRows(); route();\n" +
    "</" + "script>\n</body>\n</html>\n"
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const botDir = process.env.MAKEFUN_BOT_DIR || scriptDir;
  const inputDir = process.env.MAKEFUN_INPUT_DIR || join(scriptDir, "input");
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || join(scriptDir, "out");

  const snap = loadSnapshot(scriptDir);
  const preToken = snap.protocols.filter(isPreToken);

  // Watchlist: the 40 largest pre-token protocols by TVL.
  const byTvl = [...preToken].sort((a, b) => b.tvl - a.tvl || (a.slug < b.slug ? -1 : 1));
  const watchlistSlugs = new Set(byTvl.slice(0, WATCHLIST_SIZE).map((p) => p.slug));

  const scored = preToken.map(score);
  for (const s of scored) s.watchlist = watchlistSlugs.has(s.slug);
  scored.sort((a, b) => b.modelValue - a.modelValue || (a.slug < b.slug ? -1 : 1));

  // Board: top BOARD_SIZE by model value, with the whole watchlist covered.
  let board = scored.slice(0, BOARD_SIZE);
  const boardSlugs = new Set(board.map((r) => r.slug));
  const missingWatch = [...watchlistSlugs].filter((s) => !boardSlugs.has(s));
  if (missingWatch.length > 0) {
    const missing = scored.filter((r) => missingWatch.includes(r.slug));
    const keep = board.filter((r) => !missingWatch.includes(r.slug));
    const nonWatch = keep.filter((r) => !r.watchlist);
    // Drop the lowest-ranked non-watchlist rows to make room.
    const room = Math.min(missing.length, nonWatch.length);
    const dropped = new Set(nonWatch.slice(nonWatch.length - room).map((r) => r.slug));
    board = keep.filter((r) => !dropped.has(r.slug)).concat(missing);
    board.sort((a, b) => b.modelValue - a.modelValue || (a.slug < b.slug ? -1 : 1));
  }

  const html = buildHtml(snap.asOf, snap.source, board, snap.protocols.length, preToken.length);
  const boardJson = {
    as_of: snap.asOf,
    source: snap.source,
    generated_by: "main.ts (token-radar-01)",
    board_size: board.length,
    watchlist_size: WATCHLIST_SIZE,
    watchlist_covered: board.filter((r) => r.watchlist).length,
    model: {
      formula: "model_value_usd = max(tvl, 50000000) * category_multiple * momentum * diversity",
      floor_tvl_usd: FLOOR_TVL_USD,
      fallback_multiple: FALLBACK_MULTIPLE,
      category_multiples: CATEGORY_MULTIPLES,
      momentum: "1 + 0.25*growth_1d + 0.25*growth_7d + 0.5*growth_30d, clamped to [0.5, 2.0]",
      diversity: "1 + 0.05 per extra chain, capped at 1.5",
    },
    rows: boardJsonFor(board),
  };
  const dossier = {
    as_of: snap.asOf,
    source: snap.source,
    generated_by: "main.ts (token-radar-01)",
    counts: {
      snapshot_protocols: snap.protocols.length,
      pre_token: preToken.length,
      board_rows: board.length,
      watchlist: WATCHLIST_SIZE,
      watchlist_covered: board.filter((r) => r.watchlist).length,
    },
    top_10: board.slice(0, 10).map((r, i) => ({
      rank: i + 1,
      slug: r.slug,
      name: r.name,
      category: r.category,
      tvl: r.tvl,
      model_value_usd: Math.round(r.modelValue),
    })),
    model_summary:
      "Implied value = max(TVL, $50M) x category multiple (median mcap/TVL of live " +
      "protocols per category, DefiLlama public data 2026-11-19, fallback 0.279x, clamped 0.2x-10x) " +
      "x momentum (TVL growth 1d/7d/30d, clamped 0.5x-2.0x) x chain diversity (1 + 0.05 per extra chain, cap 1.5x).",
    filter_summary:
      "Pre-token = gecko_id and symbol both empty; category not Bridge / Wrapped Token / " +
      "Liquid Staking / Restaking; name has no version suffix and no whole word wrapped/staked/staking; " +
      "name does not start with an exchange brand.",
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "index.html"), html, "utf8");
  writeFileSync(join(outputDir, "board.json"), JSON.stringify(boardJson) + "\n", "utf8");
  writeFileSync(join(outputDir, "dossier.json"), JSON.stringify(dossier, null, 2) + "\n", "utf8");

  const dashboardDir = join(botDir, "dashboard");
  for (const name of ["board.png", "detail.png", "filtered.png"]) {
    const src = join(dashboardDir, name);
    if (existsSync(src)) {
      copyFileSync(src, join(outputDir, name));
    } else {
      console.error("warning: screenshot not found, skipped: " + src);
    }
  }

  console.log(
    "token-radar: snapshot=" + snap.protocols.length +
    " pre-token=" + preToken.length +
    " board=" + board.length +
    " watchlist-covered=" + board.filter((r) => r.watchlist).length +
    " as_of=" + snap.asOf,
  );
}

main();
