"use client";

const STAGES = [
  { key: "Pixel", label: "Pixel", description: "Source Analysis" },
  { key: "Wireframe", label: "Wireframe", description: "Design Builder" },
  { key: "Forge", label: "Forge", description: "Frontend Builder" },
] as const;

type StageStatus = "done" | "active" | "pending";

interface PipelineTrackerProps {
  currentStep: number;
  assignedTo?: string | string[];
  status: string;
}

function getStageStatus(index: number, currentStep: number, taskStatus: string): StageStatus {
  if (taskStatus === "done" || taskStatus === "review") return "done";
  if (index < currentStep) return "done";
  if (index === currentStep) return "active";
  return "pending";
}

export default function PipelineTracker({ currentStep, assignedTo, status }: PipelineTrackerProps) {
  const activeAgent = typeof assignedTo === "string" ? assignedTo : Array.isArray(assignedTo) ? assignedTo[0] : undefined;

  return (
    <div className="space-y-1">
      {STAGES.map((stage, i) => {
        const stageStatus = getStageStatus(i, currentStep, status);
        const isActive = stageStatus === "active" && activeAgent?.toLowerCase() === stage.key.toLowerCase();

        return (
          <div key={stage.key} className="flex items-center gap-3">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
              stageStatus === "done" ? "bg-green-500 text-white" :
              stageStatus === "active" ? "bg-black text-white ring-2 ring-black/20" :
              "bg-gray-200 text-gray-400"
            }`}>
              {stageStatus === "done" ? "✓" : stageStatus === "active" ? "●" : "○"}
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-medium ${stageStatus === "pending" ? "text-gray-400" : "text-gray-800"}`}>
                {stage.label}
                {isActive && <span className="ml-2 text-xs text-green-600 animate-pulse">active</span>}
              </div>
              <div className="text-[10px] text-gray-400">{stage.description}</div>
            </div>
            {i < STAGES.length - 1 && (
              <div className={`absolute left-[11px] mt-6 w-0.5 h-4 ${stageStatus === "done" ? "bg-green-300" : "bg-gray-200"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
