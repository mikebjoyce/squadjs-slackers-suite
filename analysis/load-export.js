/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              S³ EXPORT LOADER (OFFLINE ANALYSIS)              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Shared loader for the production .s3backup.json exports in
 * docs/dataDump/. Repo-root only — install.cjs copies from the five
 * plugin directories and nothing else, so nothing here is ever
 * deployed to a game server.
 *
 * The exports run to ~200 MB, which JSON.parse handles but not within
 * Node's default heap. Callers should run under
 *   node --max-old-space-size=4096
 * or use `npm run analysis:*` style invocation that sets it.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * newestExport(dir)         → path of the newest .s3backup.json
 * loadExport(file)          → { exportedAt, connector, tier, tables }
 * table(exp, name)          → rows array (empty array if absent)
 * quantile(sorted, q)       → linear-interpolated quantile
 * describe(values)          → { n, mean, sd, min, p05..p95, max }
 * histogram(values, edges)  → counts per bucket, for terminal bars
 */

import fs from 'node:fs';
import path from 'node:path';

export const DATA_DUMP = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
  'docs',
  'dataDump'
);

export function listExports(dir = DATA_DUMP) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.s3backup.json'))
    .sort();
}

export function newestExport(dir = DATA_DUMP) {
  const all = listExports(dir);
  if (all.length === 0) throw new Error(`No .s3backup.json files in ${dir}`);
  return path.join(dir, all[all.length - 1]);
}

export function loadExport(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.tables) throw new Error(`${file} has no "tables" key — not an S³ export?`);
  return parsed;
}

export function table(exp, name) {
  return exp.tables?.[name] ?? [];
}

/*
 * SquadJS delivers the same layer under two conventions — the pretty name
 * ("Yehorivka RAAS v2") and the classname ("Yehorivka_RAAS_v2") — and both
 * forms are present in this data. Underscore is a word character, so a naive
 * /\bRAAS\b/ silently fails on every classname-form row and dumps it into
 * "Other". Normalise separators before matching.
 */
export function gamemodeOf(layerName) {
  const n = String(layerName || '').replace(/[_\-]+/g, ' ');
  if (/\bseed\b/i.test(n)) return 'Seed';
  if (/\btraining\b|\btutorial\b|\bjensen/i.test(n)) return 'Training';
  if (/\binvasion\b/i.test(n)) return 'Invasion';
  if (/\bRAAS\b/i.test(n)) return 'RAAS';
  if (/\bAAS\b/i.test(n)) return 'AAS';
  if (/\bskirmish\b/i.test(n)) return 'Skirmish';
  if (/\bdestruction\b/i.test(n)) return 'Destruction';
  if (/\binsurgency\b/i.test(n)) return 'Insurgency';
  if (/\bterritory\b|\bTC\b/i.test(n)) return 'TerritoryControl';
  return 'Other';
}

/*
 * The balancer is tuned against RAAS and nothing else.
 *
 * Invasion is not a harder or easier version of the same thing — it is a
 * different ticket economy. Defenders open on roughly 800 tickets, attackers on
 * roughly 200 and earn ~150 per objective taken. A ticket count from Invasion is
 * therefore not on the same scale as a ticket count from RAAS, and the two must
 * never be pooled, averaged, or compared: doing so measures the mode mix. (Nor
 * does an Invasion mean of ~400 vs a RAAS mean of ~114 say anything about
 * balance — that gap is the starting ticket pools, not the teams.) Invasion is
 * also rare here, run as an occasional change of pace.
 *
 * Seed and Training are excluded as non-competitive. AAS and the remaining modes
 * are excluded too — together they are a handful of rounds, not enough to tune
 * against, and AAS ticket behaviour differs from RAAS as well.
 */
export const COMPETITIVE_MODES = new Set(['RAAS']);

export function isCompetitive(layerName) {
  return COMPETITIVE_MODES.has(gamemodeOf(layerName));
}

/*
 * Effective concurrent population for a round, from its Elo_RoundPlayers rows.
 *
 * Do NOT use Elo_RoundHistory.playerCount for this. That column counts DISTINCT
 * participants across the whole round — its median is ~120 against a 100-slot
 * server, and it correlates NEGATIVELY with real population (r = -0.16), because
 * a server churning through people racks up more distinct names. Filtering on it
 * selects slightly worse lobbies while looking like it does the opposite.
 *
 * participationRatio is each player's share of the round actually played, so the
 * sum approximates average concurrent bodies. It tracks the LIVE snapshot roster
 * size at r = 0.86.
 */
export function effectivePopulation(roundPlayerRows) {
  return roundPlayerRows.reduce(
    (sum, p) => sum + (Number.isFinite(p.participationRatio) ? p.participationRatio : 0),
    0
  );
}

/*
 * Full-lobby threshold. Balance behaviour on a dwindling late-night server is
 * not what the plugin is tuned for, so those rounds are excluded by default.
 *
 * Applied to Elo tables this is very nearly a no-op, and that is worth knowing
 * rather than rediscovering: EloTracker already refuses to rate any round with
 * fewer than `minPlayersForElo` (default 80) connected at ROUND_ENDED, so
 * Elo_RoundHistory is ALREADY a full-lobby-only table. The filter here drops
 * about ten further rounds, where average concurrency sagged below 80 even
 * though the count at round end cleared it.
 *
 * The corollary is the important half. TeamBalancer has no such gate — it
 * scrambles whatever is on the server — so no analysis joined to Elo can see
 * the balancer's behaviour on the lobbies Elo discarded. For that, start from
 * TB_RoundReport, which is written for every ROUND_ENDED. See
 * analysis/balancer-vs-elo-coverage.js.
 */
export const MIN_EFFECTIVE_PLAYERS = 80;

export function quantile(sortedValues, q) {
  if (sortedValues.length === 0) return NaN;
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

export function describe(values) {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = clean.length;
  if (n === 0) return { n: 0 };
  const mean = clean.reduce((s, v) => s + v, 0) / n;
  const variance = clean.reduce((s, v) => s + (v - mean) ** 2, 0) / (n > 1 ? n - 1 : 1);
  return {
    n,
    mean,
    sd: Math.sqrt(variance),
    min: clean[0],
    p05: quantile(clean, 0.05),
    p25: quantile(clean, 0.25),
    median: quantile(clean, 0.5),
    p75: quantile(clean, 0.75),
    p95: quantile(clean, 0.95),
    max: clean[n - 1]
  };
}

/** Pearson correlation. Returns { r, n } — n is the count of usable pairs. */
export function correlation(xs, ys) {
  const pairs = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  const n = pairs.length;
  if (n < 3) return { r: NaN, n };
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return { r: den === 0 ? NaN : num / den, n };
}

export function fmt(v, digits = 2) {
  return Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
}

export function bar(count, max, width = 40) {
  if (max <= 0) return '';
  return '█'.repeat(Math.max(count > 0 ? 1 : 0, Math.round((count / max) * width)));
}

/* ─── Logistic regression & model comparison ──────────────────────────────
 *
 * Shared by squad-coordination.js and newcomer-prior.js. Kept here rather than
 * copied so the two cannot drift — a nested model comparison is only meaningful
 * if both models were fitted by identical code.
 */

/**
 * Binary logistic regression by gradient descent on standardised inputs.
 *
 * Standardising is not cosmetic: the features these scripts compare live on
 * wildly different scales (a mean-mu difference of ~0.5 against a headcount
 * difference of ~5), and unstandardised GD would converge at completely
 * different rates per coefficient. `wRaw` converts back for interpretation.
 */
export function fitLogistic(X, y, { iters = 6000, lr = 0.5, l2 = 1e-4 } = {}) {
  const n = X.length;
  const k = X[0].length;
  const mu = Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[j], 0) / n);
  const sd = Array.from({ length: k }, (_, j) => {
    const v = X.reduce((s, r) => s + (r[j] - mu[j]) ** 2, 0) / n;
    return Math.sqrt(v) || 1;
  });
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const w = new Array(k).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(k).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < k; j++) z += w[j] * Z[i][j];
      const p = 1 / (1 + Math.exp(-z));
      const e = p - y[i];
      for (let j = 0; j < k; j++) gw[j] += e * Z[i][j];
      gb += e;
    }
    for (let j = 0; j < k; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  const predict = (row) => {
    let z = b;
    for (let j = 0; j < k; j++) z += w[j] * ((row[j] - mu[j]) / sd[j]);
    return 1 / (1 + Math.exp(-z));
  };
  let ll = 0;
  let correct = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, predict(X[i])));
    ll += y[i] ? Math.log(p) : Math.log(1 - p);
    if (p > 0.5 === (y[i] === 1)) correct++;
  }
  return { w, wRaw: w.map((v, j) => v / sd[j]), b, ll, acc: correct / n, predict, k };
}

/**
 * k-fold cross-validation over contiguous blocks.
 *
 * Contiguous rather than shuffled is deliberate: rows arrive in export order,
 * so contiguous folds are roughly chronological and the held-out score also
 * answers "does this hold up outside its own time period". Shuffling would leak
 * era effects between train and test and flatter every model.
 */
export function crossValidate(X, y, folds = 5) {
  const n = X.length;
  let total = 0;
  let correct = 0;
  for (let f = 0; f < folds; f++) {
    const lo = Math.floor((f * n) / folds);
    const hi = Math.floor(((f + 1) * n) / folds);
    const trX = [];
    const trY = [];
    for (let i = 0; i < n; i++) {
      if (i >= lo && i < hi) continue;
      trX.push(X[i]);
      trY.push(y[i]);
    }
    const m = fitLogistic(trX, trY);
    for (let i = lo; i < hi; i++) {
      const p = Math.min(1 - 1e-12, Math.max(1e-12, m.predict(X[i])));
      total += y[i] ? -Math.log(p) : -Math.log(1 - p);
      if (p > 0.5 === (y[i] === 1)) correct++;
    }
  }
  return { logLoss: total / n, acc: correct / n };
}

/** Log-gamma (Lanczos). Support for `chiSqP`. */
export function lnGamma(z) {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Chi-square survival function, via the regularised upper incomplete gamma. */
export function chiSqP(x, df) {
  if (x <= 0) return 1;
  const k = df / 2;
  const xx = x / 2;
  if (xx < k + 1) {
    let sum = 1 / k;
    let term = sum;
    for (let i = 1; i < 500; i++) {
      term *= xx / (k + i);
      sum += term;
      if (term < sum * 1e-14) break;
    }
    return 1 - Math.exp(-xx + k * Math.log(xx) - lnGamma(k) + Math.log(sum));
  }
  let b = xx + 1 - k;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - k);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-xx + k * Math.log(xx) - lnGamma(k)) * h;
}

/** Formats a p-value for table output. */
export function pStr(p) {
  return p < 0.001 ? '<0.001' : fmt(p, 3);
}
