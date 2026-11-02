/** Soft, distinguishable fills for liquid strata / share markers (light theme). */
const STRATA_COLORS = ["#9db596", "#dcbf8e", "#d29a86", "#8fb0ad", "#c2b0cf", "#b5bf7d", "#e0ad6e", "#a6b3c4"] as const;

export function strataColor(i: number): string {
  return STRATA_COLORS[i % STRATA_COLORS.length] ?? STRATA_COLORS[0];
}
