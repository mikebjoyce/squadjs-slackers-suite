/**
 * ─────────────────────────────────────────────────────────────────
 *  s3-locale-merge.js — join translation tiers into one catalogue
 * ─────────────────────────────────────────────────────────────────
 *
 *  ─── PURPOSE ─────────────────────────────────────────────────────
 *
 *  The translator templates are three disjoint slices of one key tree —
 *  in-game, admin Discord, server log — so a language that translates more
 *  than one tier has to combine them. They cannot simply be pasted into the
 *  same object literal: every tier carries a `teamBalancer` branch, and a
 *  duplicate key in an object literal silently replaces the earlier one. The
 *  loss is invisible — the dropped tier just falls back to English, with no
 *  error anywhere — so this does the join properly instead.
 *
 *  ─── EXPORTS ─────────────────────────────────────────────────────
 *
 *  mergeMessages(...trees) (named, and default)
 *    Deep-merges catalogue objects left to right and returns a new tree.
 *    Later arguments win on a collision, but since the tiers are disjoint,
 *    a collision means two tiers claim the same key — a bug in the split.
 *
 *  ─── USAGE ───────────────────────────────────────────────────────
 *
 *    import mergeMessages from './s3-locale-merge.js';
 *
 *    export const MESSAGES = mergeMessages(
 *      { ...in-game tier... },
 *      { ...admin Discord tier... }
 *    );
 *
 *  A catalogue that translates only one tier needs none of this — a plain
 *  `export const MESSAGES = { ... }` is still the normal shape.
 *
 *  ─── NOTES ───────────────────────────────────────────────────────
 *
 *  - Does not import s3-i18n.js. The catalogues are imported BY s3-i18n.js,
 *    so anything they depend on has to sit outside that module or the import
 *    cycle leaves CATALOGUES half-built at load time.
 *  - Inputs are never mutated; the caller keeps its own objects intact.
 *
 *  Author:
 *  Discord: `real_slacker`
 * ─────────────────────────────────────────────────────────────────
 */

const isTree = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {...object} trees Catalogue fragments, in tier order.
 * @returns {object} A new tree containing every leaf of every fragment.
 */
export function mergeMessages(...trees) {
  const out = {};
  for (const tree of trees) {
    if (!isTree(tree)) continue;
    for (const [key, value] of Object.entries(tree)) {
      out[key] = isTree(value) && isTree(out[key]) ? mergeMessages(out[key], value) : value;
    }
  }
  return out;
}

export default mergeMessages;
