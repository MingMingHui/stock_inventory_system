// Lightweight, dependency-free charts (SVG / CSS). Each chart has a text
// alternative; the underlying figures are always available in a table too.

interface BarDatum {
  label: string;
  value: number;
  title?: string;
}

/** Vertical bars, e.g. revenue per month. */
export function ColumnChart({ data, ariaLabel, format }: { data: BarDatum[]; ariaLabel: string; format: (v: number) => string }) {
  const max = Math.max(0, ...data.map((d) => d.value));
  const width = Math.max(1, data.length) * 48;
  const height = 160;
  const plot = height - 34;
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${ariaLabel}: ${data.map((d) => `${d.label} ${format(d.value)}`).join(', ')}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {data.map((d, i) => {
        const h = max > 0 ? Math.round((Math.max(0, d.value) / max) * (plot - 14)) : 0;
        const x = i * 48 + 8;
        return (
          <g key={d.label}>
            <title>{d.title ?? `${d.label}: ${format(d.value)}`}</title>
            <rect className="chart-bar" x={x} y={plot - h} width={32} height={h} rx={3} />
            <text className="chart-label" x={x + 16} y={height - 18} textAnchor="middle">
              {d.label}
            </text>
          </g>
        );
      })}
      <line className="chart-axis" x1={0} x2={width} y1={plot} y2={plot} />
    </svg>
  );
}

/** Horizontal bars with labels, e.g. top items or category share. */
export function BarList({ data, format, emptyText }: { data: BarDatum[]; format: (v: number) => string; emptyText: string }) {
  const max = Math.max(0, ...data.map((d) => d.value));
  if (data.length === 0) return <p className="muted">{emptyText}</p>;
  return (
    <ul className="bar-list">
      {data.map((d) => (
        <li key={d.label} title={d.title}>
          <span className="bar-list-label">{d.label}</span>
          <span className="bar-list-track" aria-hidden="true">
            <span className="bar-list-fill" style={{ width: `${max > 0 ? Math.max(2, (d.value / max) * 100) : 0}%` }} />
          </span>
          <span className="bar-list-value">{format(d.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Tiny monthly-units trend (oldest → newest). */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  const w = values.length * 7;
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} 20`} width={w} height={20} role="img" aria-label={`${label}: ${values.join(', ')}`}>
      {values.map((v, i) => {
        const h = v > 0 ? Math.max(2, Math.round((v / max) * 18)) : 1;
        return <rect key={i} x={i * 7} y={20 - h} width={5} height={h} className={v > 0 ? 'spark-bar' : 'spark-empty'} />;
      })}
    </svg>
  );
}
