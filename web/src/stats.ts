/** Mann-Kendall test (normal approximation, tie-corrected) and Sen's slope. */
export function mannKendall(x: number[]): { s: number; p: number; slope: number } {
  const n = x.length;
  if (n < 4) return { s: 0, p: 1, slope: 0 };
  let s = 0;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      s += Math.sign(x[j] - x[i]);
      slopes.push((x[j] - x[i]) / (j - i));
    }
  }
  const counts = new Map<number, number>();
  for (const v of x) counts.set(v, (counts.get(v) ?? 0) + 1);
  let tie = 0;
  for (const t of counts.values()) if (t > 1) tie += t * (t - 1) * (2 * t + 5);
  const variance = (n * (n - 1) * (2 * n + 5) - tie) / 18;
  const z = s > 0 ? (s - 1) / Math.sqrt(variance) : s < 0 ? (s + 1) / Math.sqrt(variance) : 0;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  slopes.sort((a, b) => a - b);
  const m = slopes.length;
  const slope = m % 2 ? slopes[(m - 1) / 2] : (slopes[m / 2 - 1] + slopes[m / 2]) / 2;
  return { s, p, slope };
}

function normCdf(z: number): number {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * (z / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return 0.5 * (1 + y);
}

export const fmtInt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export const fmt1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
export const fmt2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export function fmtP(p: number): string {
  if (p < 0.001) return "p < 0.001";
  return `p = ${p.toFixed(3)}`;
}
