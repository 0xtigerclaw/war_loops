"use client";

const WIREFRAME_GATES = ["G04", "G05", "G06", "G08", "G09"] as const;

const GATE_LABELS: Record<string, string> = {
  G04: "Content",
  G05: "Layout",
  G06: "Responsive",
  G08: "Semantic",
  G09: "Typography",
};

const STATUS_COLORS: Record<string, string> = {
  pass: "bg-green-500",
  fail: "bg-red-500",
  blocked: "bg-yellow-500",
  not_applicable: "bg-gray-300",
};

interface GateGridProps {
  gates: Record<string, { status: string; score?: number }> | null;
  compact?: boolean;
}

export default function GateGrid({ gates, compact = false }: GateGridProps) {
  if (!gates) return null;

  if (compact) {
    return (
      <div className="flex gap-1">
        {WIREFRAME_GATES.map((g) => {
          const result = gates[g];
          const color = result ? STATUS_COLORS[result.status] || "bg-gray-300" : "bg-gray-200";
          return (
            <div
              key={g}
              className={`w-2 h-2 rounded-full ${color}`}
              title={`${g}: ${result?.status || "pending"}`}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      {WIREFRAME_GATES.map((g) => {
        const result = gates[g];
        const status = result?.status || "pending";
        const color = STATUS_COLORS[status] || "bg-gray-200";
        return (
          <div key={g} className="flex flex-col items-center gap-1">
            <div className={`w-8 h-8 rounded-lg ${color} flex items-center justify-center text-white text-xs font-bold`}>
              {status === "pass" ? "✓" : status === "fail" ? "✗" : "•"}
            </div>
            <span className="text-[10px] text-gray-500 font-medium">{GATE_LABELS[g] || g}</span>
            {result?.score !== undefined && (
              <span className="text-[10px] text-gray-400">{result.score}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
