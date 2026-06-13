"use client";

import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useParams } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useState, useMemo } from "react";
import GateGrid from "../components/GateGrid";
import ScoreSparkline from "../components/ScoreSparkline";
import PipelineTracker from "../components/PipelineTracker";
import FindingCard from "../components/FindingCard";

type TaskOutput = {
  stepNumber: number;
  title: string;
  content: string;
  agent: string;
  createdAt: number;
};

type Finding = {
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
};

type Evaluation = {
  _id: string;
  taskId: Id<"tasks">;
  iteration: number;
  stage: string;
  decision: string;
  overallScore?: number;
  gates?: Record<string, { status: string; score?: number }>;
  findings?: Finding[];
  runtime: string;
  createdAt: number;
};

const DECISION_STYLES: Record<string, string> = {
  pass: "bg-green-100 text-green-800 border-green-200",
  iterate: "bg-amber-100 text-amber-800 border-amber-200",
  fail: "bg-red-100 text-red-800 border-red-200",
};

export default function MirrorDetailPage() {
  const params = useParams<{ id: string | string[] }>();
  const taskId = (Array.isArray(params.id) ? params.id[0] : params.id) as Id<"tasks">;
  const task = useQuery(api.tasks.get, taskId ? { id: taskId } : "skip");
  const evaluations = useQuery(api.evaluations.listByTask, taskId ? { taskId } : "skip") as Evaluation[] | undefined;

  const [selectedIteration, setSelectedIteration] = useState<number | null>(null);
  const [activeOutputTab, setActiveOutputTab] = useState<string>("Pixel");

  const scores = useMemo(
    () => (evaluations || []).filter(e => e.overallScore != null).map(e => e.overallScore!),
    [evaluations]
  );

  const selectedEval = useMemo(() => {
    if (!evaluations || evaluations.length === 0) return null;
    if (selectedIteration !== null) return evaluations.find(e => e.iteration === selectedIteration) || null;
    return evaluations[evaluations.length - 1];
  }, [evaluations, selectedIteration]);

  const findings = useMemo(() => {
    if (!selectedEval?.findings) return [];
    return (selectedEval.findings as Finding[]).sort((a, b) => {
      const order: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, Note: 4 };
      return (order[a.severity] ?? 5) - (order[b.severity] ?? 5);
    });
  }, [selectedEval]);

  const findingSummary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of findings) {
      counts[f.severity] = (counts[f.severity] || 0) + 1;
    }
    return counts;
  }, [findings]);

  const outputs = useMemo(() => {
    if (!task?.outputs) return [];
    return (task.outputs as TaskOutput[]).sort((a, b) => a.stepNumber - b.stepNumber);
  }, [task]);

  const outputsByAgent = useMemo(() => {
    const grouped: Record<string, TaskOutput[]> = {};
    for (const o of outputs) {
      if (!grouped[o.agent]) grouped[o.agent] = [];
      grouped[o.agent].push(o);
    }
    return grouped;
  }, [outputs]);

  const agentTabs = ["Pixel", "Wireframe", "Forge", "Orchestrator"].filter(a => outputsByAgent[a]);

  if (!task) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white text-black font-sans">
      {/* Sticky Header */}
      <header className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-gray-200 px-6 py-3">
        <div className="flex items-center justify-between max-w-[1600px] mx-auto">
          <div className="flex items-center gap-3">
            <Link href="/mirror" className="text-gray-400 hover:text-gray-600 transition-colors">
              <ChevronLeft size={20} />
            </Link>
            <div>
              <h1 className="text-lg font-semibold">{task.title}</h1>
              <p className="text-xs text-gray-400">
                {task.status} · {task.pipelineType || "frontend-mirror"}
                {task.iterationCount !== undefined && ` · iteration ${task.iterationCount}`}
              </p>
            </div>
          </div>
          <div className={`px-3 py-1 rounded-full text-xs font-bold border ${
            task.status === "done" ? "bg-green-50 text-green-700 border-green-200" :
            task.status === "review" ? "bg-purple-50 text-purple-700 border-purple-200" :
            task.status === "in_progress" ? "bg-yellow-50 text-yellow-700 border-yellow-200" :
            "bg-gray-50 text-gray-500 border-gray-200"
          }`}>
            {task.status.replace("_", " ")}
          </div>
        </div>
      </header>

      <div className="max-w-[1600px] mx-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Left Panel — Pipeline & History */}
          <div className="space-y-6">
            {/* Pipeline Tracker */}
            <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Pipeline</h3>
              <PipelineTracker
                currentStep={task.currentStep || 0}
                assignedTo={task.assignedTo}
                status={task.status}
              />
            </div>

            {/* Iteration History */}
            <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Iterations</h3>
              {(!evaluations || evaluations.length === 0) ? (
                <div className="text-xs text-gray-400 text-center py-4">No evaluations yet</div>
              ) : (
                <div className="space-y-1">
                  {evaluations.map((ev) => (
                    <button
                      key={ev._id}
                      onClick={() => setSelectedIteration(ev.iteration)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-colors ${
                        (selectedIteration === ev.iteration || (selectedIteration === null && ev === evaluations[evaluations.length - 1]))
                          ? "bg-white border border-gray-300 shadow-sm"
                          : "hover:bg-gray-100"
                      }`}
                    >
                      <span className="font-medium text-gray-700">#{ev.iteration}</span>
                      <span className={`font-bold ${
                        ev.overallScore !== undefined
                          ? ev.overallScore >= 85 ? "text-green-600" : ev.overallScore >= 75 ? "text-amber-600" : "text-red-600"
                          : "text-gray-400"
                      }`}>
                        {ev.overallScore !== undefined ? ev.overallScore : "—"}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${DECISION_STYLES[ev.decision] || "bg-gray-100 border-gray-200"}`}>
                        {ev.decision}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Score Progression */}
            {scores.length > 0 && (
              <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Score Progression</h3>
                <div className="flex justify-center">
                  <ScoreSparkline scores={scores} height={80} width={200} />
                </div>
                <div className="flex justify-between text-[10px] text-gray-400 mt-2 px-1">
                  <span>Iter 0</span>
                  <span className="text-gray-300">— 75 threshold —</span>
                  <span>Iter {scores.length - 1}</span>
                </div>
              </div>
            )}
          </div>

          {/* Right Panel — Evaluation Detail (2 cols wide) */}
          <div className="lg:col-span-2 space-y-6">
            {/* Score + Decision + Gates */}
            {selectedEval ? (
              <div className="bg-gray-50 rounded-xl p-5 border border-gray-200">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
                      Evaluation #{selectedEval.iteration} · {selectedEval.stage}
                    </h3>
                    <div className="flex items-baseline gap-3">
                      <span className={`text-3xl font-bold ${
                        selectedEval.overallScore !== undefined
                          ? selectedEval.overallScore >= 85 ? "text-green-600" : selectedEval.overallScore >= 75 ? "text-amber-600" : "text-red-600"
                          : "text-gray-400"
                      }`}>
                        {selectedEval.overallScore !== undefined ? selectedEval.overallScore : "—"}
                      </span>
                      <span className="text-gray-400 text-sm">/100</span>
                    </div>
                  </div>
                  <span className={`px-3 py-1.5 rounded-lg text-sm font-bold border ${DECISION_STYLES[selectedEval.decision] || "bg-gray-100 border-gray-200"}`}>
                    {selectedEval.decision}
                  </span>
                </div>

                {/* Gate Grid */}
                {selectedEval.gates && (
                  <div className="mb-4">
                    <h4 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Gate Results</h4>
                    <GateGrid gates={selectedEval.gates} />
                  </div>
                )}

                {/* Runtime info */}
                <div className="text-[10px] text-gray-400">
                  Runtime: {selectedEval.runtime} · {new Date(selectedEval.createdAt).toLocaleString()}
                </div>
              </div>
            ) : (
              <div className="bg-gray-50 rounded-xl p-8 border border-gray-200 text-center">
                <div className="text-gray-400 text-sm">No evaluation selected</div>
                <div className="text-gray-300 text-xs mt-1">Evaluations will appear here as the pipeline runs</div>
              </div>
            )}

            {/* Findings */}
            {findings.length > 0 && (
              <div className="bg-gray-50 rounded-xl p-5 border border-gray-200">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Findings</h3>
                <div className="flex gap-2 mb-3">
                  {Object.entries(findingSummary).map(([severity, count]) => (
                    <span key={severity} className="text-[10px] font-medium text-gray-500">
                      {count} {severity}
                    </span>
                  ))}
                </div>
                <div className="space-y-2">
                  {findings.map((f) => (
                    <FindingCard key={f.id} finding={f} />
                  ))}
                </div>
              </div>
            )}

            {/* Agent Outputs */}
            {agentTabs.length > 0 && (
              <div className="bg-gray-50 rounded-xl border border-gray-200 overflow-hidden">
                <div className="flex border-b border-gray-200">
                  {agentTabs.map((agent) => (
                    <button
                      key={agent}
                      onClick={() => setActiveOutputTab(agent)}
                      className={`px-4 py-2.5 text-xs font-semibold uppercase tracking-wider transition-colors ${
                        activeOutputTab === agent
                          ? "bg-white text-black border-b-2 border-black"
                          : "text-gray-400 hover:text-gray-600"
                      }`}
                    >
                      {agent}
                    </button>
                  ))}
                </div>
                <div className="p-4 max-h-[400px] overflow-y-auto">
                  {outputsByAgent[activeOutputTab]?.map((output, i) => (
                    <div key={i} className="mb-4 last:mb-0">
                      <div className="text-xs font-medium text-gray-500 mb-1">
                        Step {output.stepNumber} · {output.title}
                      </div>
                      <pre className="text-xs text-gray-700 whitespace-pre-wrap bg-white rounded-lg p-3 border border-gray-100 font-mono">
                        {output.content}
                      </pre>
                    </div>
                  ))}
                  {!outputsByAgent[activeOutputTab] && (
                    <div className="text-gray-400 text-xs text-center py-4">No output from {activeOutputTab} yet</div>
                  )}
                </div>
              </div>
            )}

            {/* Source Description */}
            {task.description && (
              <div className="bg-gray-50 rounded-xl p-5 border border-gray-200">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Source</h3>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{task.description}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
