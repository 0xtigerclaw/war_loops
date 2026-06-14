"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Eye, PenTool, Hammer, Layers } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const PIPELINE_AGENTS = [
  { name: "Pixel", skill: "Source Analyzer", icon: Eye, description: "Browser-use extraction" },
  { name: "Wireframe", skill: "Design Builder", icon: PenTool, description: "Pencil MCP iteration" },
  { name: "Forge", skill: "Frontend Builder", icon: Hammer, description: "React + Tailwind" },
] as const;

type Task = {
  _id: string;
  status: string;
  pipelineType?: string;
  assignedTo?: string | string[];
  currentStep?: number;
  workflow?: Array<string | string[]>;
};

function getAgentStatus(agentName: string, activeTasks: Task[]): "active" | "sleeping" {
  return activeTasks.some(t => {
    const assigned = Array.isArray(t.assignedTo) ? t.assignedTo : [t.assignedTo];
    return assigned.includes(agentName);
  }) ? "active" : "sleeping";
}

function getActiveCount(activeTasks: Task[]): number {
  return activeTasks.filter(t =>
    ["assigned", "in_progress"].includes(t.status)
  ).length;
}

export default function MirrorSquad() {
  const allTasks = useQuery(api.tasks.list) as Task[] | undefined;

  const mirrorTasks = (allTasks || []).filter(t => t.pipelineType === "frontend-mirror");
  const activeTasks = mirrorTasks.filter(t => !["done", "cancelled", "inbox"].includes(t.status));
  const activeCount = getActiveCount(activeTasks);

  return (
    <div className="space-y-4">
      {/* Frontend Mirror Team */}
      <div className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-4">
        <div className="flex items-center gap-2 mb-4">
          <div className="p-1.5 rounded-lg bg-violet-600 text-white">
            <Layers size={16} />
          </div>
          <h3 className="font-semibold text-sm text-violet-900">War Loops</h3>
          <span className="text-xs text-violet-600 bg-violet-100 px-2 py-0.5 rounded-full ml-auto">
            Pixel → Wireframe ⟳ Eval → Forge
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {PIPELINE_AGENTS.map((agent, index) => {
            const status = getAgentStatus(agent.name, activeTasks);
            const isActive = status === "active";
            const Icon: LucideIcon = agent.icon;

            return (
              <div key={agent.name} className="relative">
                {index < PIPELINE_AGENTS.length - 1 && (
                  <div className="absolute top-1/2 -right-3 transform -translate-y-1/2 text-violet-300 text-lg z-10">
                    {index === 1 ? "⟳" : "→"}
                  </div>
                )}
                <div className={`p-3 rounded-xl border transition-all ${
                  isActive ? "border-violet-300 bg-white shadow-sm" : "border-violet-100 bg-white/50"
                }`}>
                  <div className="flex items-center gap-3 mb-2">
                    <div className={`p-2 rounded-lg ${isActive ? "bg-violet-600 text-white" : "bg-violet-100 text-violet-500"}`}>
                      <Icon size={18} />
                    </div>
                    <div>
                      <h3 className="font-semibold text-sm text-black">{agent.name}</h3>
                      <p className="text-xs text-violet-600">{agent.skill}</p>
                      <p className="text-[10px] text-gray-400">{agent.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-green-500 animate-pulse" : "bg-gray-300"}`} />
                    <span className="text-xs uppercase tracking-wider text-gray-400 font-medium">{status}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Pipeline Stats Bar */}
      {activeCount > 0 && (
        <div className="flex items-center gap-2 text-xs text-violet-600 bg-violet-50 border border-violet-100 rounded-lg px-3 py-2">
          <div className="w-2 h-2 rounded-full bg-violet-500 animate-pulse" />
          <span className="font-medium">{activeCount} active mirror task{activeCount !== 1 ? "s" : ""}</span>
        </div>
      )}
    </div>
  );
}
