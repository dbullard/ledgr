import { centsToDisplay } from "@/lib/money";

/** Per-unit price over time as a small line. Pure SVG, so it renders on the server. */
export function PriceSparkline({
  points,
  label,
}: {
  points: { date: string; unitCents: number }[];
  label: string;
}) {
  const W = 560;
  const H = 120;
  const PAD = 8;
  if (points.length === 0) return null;
  const prices = points.map((p) => p.unitCents);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const x = (i: number) => (points.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (points.length - 1));
  const y = (c: number) => H - PAD - ((c - min) * (H - 2 * PAD)) / span;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.unitCents).toFixed(1)}`).join(" ");

  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${label}: from ${centsToDisplay(points[0].unitCents)} to ${centsToDisplay(points[points.length - 1].unitCents)}`}
        className="h-32 w-full"
      >
        <path d={d} fill="none" stroke="currentColor" strokeWidth="2" className="text-primary" />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.unitCents)} r="3" className="fill-primary" />
        ))}
      </svg>
      <figcaption className="flex justify-between text-xs text-muted-foreground">
        <span>Low {centsToDisplay(min)}</span>
        <span>High {centsToDisplay(max)}</span>
      </figcaption>
    </figure>
  );
}
