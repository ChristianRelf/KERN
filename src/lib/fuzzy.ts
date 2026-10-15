/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Small fuzzy matcher for commands and navigation: subsequence matching
// with bonuses for word starts, consecutive runs and prefix matches.

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) {
    const wordStart = idx === 0 || /[\s\-_/.]/.test(t[idx - 1]);
    return (wordStart ? 700 : 500) - idx - t.length * 0.1;
  }
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === " ") continue;
    let found = false;
    while (ti < t.length) {
      if (t[ti] === c) {
        const atWord = ti === 0 || /[\s\-_/.]/.test(t[ti - 1]);
        run = qi > 0 && t[ti - 1] === q[qi - 1] ? run + 1 : 0;
        score += 10 + (atWord ? 15 : 0) + run * 6;
        ti++;
        found = true;
        break;
      }
      ti++;
    }
    if (!found) return null;
  }
  return score - t.length * 0.2;
}

export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string, keywords?: (item: T) => string): T[] {
  if (!query.trim()) return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const a = fuzzyScore(query, text(item));
    const b = keywords ? fuzzyScore(query, keywords(item)) : null;
    const s = Math.max(a ?? -Infinity, b !== null ? b - 50 : -Infinity);
    if (s > -Infinity) scored.push({ item, score: s });
  }
  return scored.sort((x, y) => y.score - x.score).map((x) => x.item);
}
