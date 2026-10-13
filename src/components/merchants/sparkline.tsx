/**
 * A tiny line of monthly values (P8 merchant page). Spend is drawn upward:
 * pass absolute values. The values are also in the accessible label.
 */
export function Sparkline({ values, label, width = 120, height = 32 }: { values: number[]; label: string; width?: number; height?: number }) {
  if (!values.length) return null;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`).join(" ");
  return (
    <svg role="img" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible text-primary">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
