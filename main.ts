// polymarket-nvidia-ceo-forecast-01 — per-market volatility forecaster.
// Node 22, standard library only, no network, deterministic.
//
// Model (calibrated on the 6 practice cases; see build log):
//   For each market, take the last price x and the RMS of its 1-minute
//   moves over the last 6 hours (360 minutes). That recent RMS is the
//   market's own 1-minute scale sigma1 (floored at 0.0025, capped at 0.05,
//   times 1.2). The forecast for minute h after the checkpoint is
//       q_tau(h) = x + z_tau * sigma1 * h^0.18
//   with z the standard normal quantiles at 0.05/0.25/0.5/0.75/0.95.
//   The median is the last price: no drift (a recent-trend drift hurt on
//   practice) and no center shrink (also hurt). The exponent 0.18 reflects
//   that these prices are strongly mean-reverting: h-step volatility grows
//   far slower than the random-walk sqrt(h) the house baseline assumes.
//   Practice loss 0.282904 vs the house baseline's 0.363589 (-22%),
//   beating it on all 6 practice cases, 90% coverage 0.9017.
//
// Input: every *.in file in MAKEFUN_INPUT_DIR (else /input): one JSON case
//   {schema, competition, case, at, horizon_minutes, quantiles, event,
//    markets: [{id, name, slug, yes_token, start, prices}]}, prices one
//   number per minute from start to at inclusive, last = price at checkpoint.
// Output: <id>.out per case: {"forecasts": [{id, q}]}, q exactly
//   horizon_minutes rows of 5 non-decreasing numbers in [0, 1].
// Runs in well under the 8 s per-case cap; two runs are byte-identical
// (no randomness, no clock).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, to 6 decimals. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];

/** Calibrated constants (practice grid search; flat optimum, not a knife edge). */
const VOL_WINDOW_MIN = 360; // 6h of 1-minute moves for the per-market RMS
const SIGMA_SCALE = 1.2; // multiplier on the recent RMS
const SIGMA_FLOOR = 0.0025; // never narrower than the house baseline's sigma
const SIGMA_CAP = 0.05; // never wider than this per-minute scale
const ALPHA = 0.18; // h-step volatility exponent: sigma_h = sigma1 * h^ALPHA

/** x clamped to [0, 1] and rounded to 6 decimals (0, never -0). */
const price6 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/**
 * A market's 1-minute scale: RMS of its 1-minute moves over the recent
 * window, floored and capped. Markets with almost no history (n - 1 moves
 * below the window) use what they have; a market with a single price (no
 * moves at all) falls back to the floor, i.e. the house baseline's sigma.
 */
function recentSigma(prices) {
  const n = prices.length;
  const win = Math.min(n - 1, VOL_WINDOW_MIN);
  if (win <= 0) return SIGMA_FLOOR;
  let ss = 0;
  for (let i = n - win; i < n; i++) {
    const d = prices[i] - prices[i - 1];
    ss += d * d;
  }
  const rms = Math.sqrt(ss / win);
  return Math.min(SIGMA_CAP, Math.max(SIGMA_FLOOR, rms * SIGMA_SCALE));
}

/**
 * Forecast one market: horizon rows of the five quantiles around its last
 * price, spread by its own recent volatility growing like h^0.18.
 */
function forecastMarket(prices, horizon) {
  const n = prices.length;
  if (n === 0) throw new Error('market has no prices');
  const x = prices[n - 1];
  const sigma1 = recentSigma(prices);
  const rows = [];
  for (let h = 1; h <= horizon; h++) {
    const s = sigma1 * Math.pow(h, ALPHA);
    const row = Z.map((z) => price6(x + z * s));
    // Safety: enforce non-decreasing after clamping (clamping preserves
    // order, but never ship a row that violates the format).
    for (let j = 1; j < 5; j++) if (row[j] < row[j - 1]) row[j] = row[j - 1];
    rows.push(row);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8'));
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) {
    throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  }
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecastMarket(m.prices, c.horizon_minutes) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
