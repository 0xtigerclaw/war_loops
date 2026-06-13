"use client";

interface ScoreSparklineProps {
  scores: number[];
  height?: number;
  width?: number;
}

export default function ScoreSparkline({ scores, height = 48, width = 120 }: ScoreSparklineProps) {
  if (scores.length === 0) return null;

  const maxScore = 100;
  const padding = 4;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;

  const points = scores.map((score, i) => {
    const x = padding + (scores.length === 1 ? innerWidth / 2 : (i / (scores.length - 1)) * innerWidth);
    const y = padding + innerHeight - (score / maxScore) * innerHeight;
    return `${x},${y}`;
  });

  const polyline = points.join(" ");
  const lastScore = scores[scores.length - 1];
  const lastPoint = points[points.length - 1].split(",");

  return (
    <svg width={width} height={height} className="overflow-visible">
      {/* Threshold line at 75 */}
      <line
        x1={padding}
        y1={padding + innerHeight - (75 / maxScore) * innerHeight}
        x2={width - padding}
        y2={padding + innerHeight - (75 / maxScore) * innerHeight}
        stroke="#d1d5db"
        strokeDasharray="2,2"
        strokeWidth="1"
      />
      {/* Score line */}
      <polyline
        points={polyline}
        fill="none"
        stroke={lastScore >= 75 ? "#22c55e" : lastScore >= 50 ? "#eab308" : "#ef4444"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Current score dot */}
      <circle
        cx={parseFloat(lastPoint[0])}
        cy={parseFloat(lastPoint[1])}
        r="3"
        fill={lastScore >= 75 ? "#22c55e" : lastScore >= 50 ? "#eab308" : "#ef4444"}
      />
    </svg>
  );
}
