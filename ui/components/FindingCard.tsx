"use client";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

interface Finding {
  id: string;
  severity: string;
  category: string;
  viewport: string;
  state: string;
  observed: string;
  expected: string;
  repair_instruction: string;
  acceptance_check: string;
  evidence?: string[];
}

const SEVERITY_COLORS: Record<string, string> = {
  P0: "bg-red-600 text-white",
  P1: "bg-red-500 text-white",
  P2: "bg-amber-500 text-white",
  P3: "bg-yellow-400 text-gray-800",
  Note: "bg-gray-300 text-gray-700",
};

export default function FindingCard({ finding }: { finding: Finding }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 p-3 text-left hover:bg-gray-50 transition-colors"
      >
        {expanded ? <ChevronDown size={14} className="text-gray-400 shrink-0" /> : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${SEVERITY_COLORS[finding.severity] || "bg-gray-200"}`}>
          {finding.severity}
        </span>
        <span className="text-xs text-gray-500 font-medium">{finding.category}</span>
        <span className="text-xs text-gray-400 ml-auto">{finding.viewport}/{finding.state}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 text-xs border-t border-gray-100 pt-2">
          <div>
            <span className="font-medium text-gray-500">Observed: </span>
            <span className="text-gray-700">{finding.observed}</span>
          </div>
          <div>
            <span className="font-medium text-gray-500">Expected: </span>
            <span className="text-gray-700">{finding.expected}</span>
          </div>
          <div className="bg-blue-50 border border-blue-100 rounded p-2">
            <span className="font-medium text-blue-700">Repair: </span>
            <span className="text-blue-800">{finding.repair_instruction}</span>
          </div>
          <div>
            <span className="font-medium text-gray-500">Verify: </span>
            <span className="text-gray-600">{finding.acceptance_check}</span>
          </div>
        </div>
      )}
    </div>
  );
}
