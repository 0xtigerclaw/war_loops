"use client";
import { Plus, ArrowLeft } from "lucide-react";
import MirrorSquad from "./components/MirrorSquad";
import ActivityFeed from "../components/ActivityFeed";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import Link from "next/link";
import { useMemo } from "react";
import type { Id } from "../../convex/_generated/dataModel";
import GateGrid from "./components/GateGrid";
import ScoreSparkline from "./components/ScoreSparkline";

type Task = {
  _id: Id<"tasks">;
  title: string;
  status: string;
  pipelineType?: string;
  iterationCount?: number;
  workflow?: Array<string | string[]>;
  currentStep?: number;
  assignedTo?: string | string[];
};

type Evaluation = {
  _id: string;
  taskId: Id<"tasks">;
  iteration: number;
  stage: string;
  decision: string;
  overallScore?: number;
  gates?: Record<string, { status: string; score?: number }>;
  findings?: Array<{ severity: string }>;
  runtime: string;
  createdAt: number;
};

function NewMirrorTaskModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const createTask = useMutation(api.tasks.create);
  const [title, setTitle] = useState("");
  const [sourceRef, setSourceRef] = useState("");

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!sourceRef.trim()) return;
    await createTask({
      title: title.trim() || `Mirror: ${sourceRef.trim().slice(0, 40)}`,
      description: `Source: ${sourceRef.trim()}`,
      priority: "medium",
      pipelineType: "frontend-mirror",
      workflow: ["Pixel", "Wireframe", "Forge"],
    });
    setTitle("");
    setSourceRef("");
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4">New Mirror Task</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Source URL or Image Path</label>
            <input
              type="text"
              value={sourceRef}
              onChange={(e) => setSourceRef(e.target.value)}
              placeholder="https://example.com or /path/to/image.png"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1 focus:outline-none focus:ring-2 focus:ring-black/10"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Title (optional)</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Mirror: Landing Page"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mt-1 focus:outline-none focus:ring-2 focus:ring-black/10"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={!sourceRef.trim()}
            className="px-4 py-2 bg-black text-white text-sm rounded-lg font-medium hover:bg-gray-800 disabled:opacity-40"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function MirrorTaskCard({ task, latestEval }: { task: Task; latestEval?: Evaluation }) {
  const evaluations = useQuery(api.evaluations.listByTask, { taskId: task._id }) as Evaluation[] | undefined;
  const scores = useMemo(() => (evaluations || []).filter(e => e.overallScore != null).map(e => e.overallScore!), [evaluations]);

  const decisionColors: Record<string, string> = {
    pass: "bg-green-100 text-green-700 border-green-200",
    iterate: "bg-amber-100 text-amber-700 border-amber-200",
    fail: "bg-red-100 text-red-700 border-red-200",
  };

  const scoreColor = (score?: number) => {
    if (score === undefined) return "text-gray-400";
    if (score >= 85) return "text-green-600";
    if (score >= 75) return "text-amber-600";
    return "text-red-600";
  };

  return (
    <Link
      href={`/mirror/${task._id}`}
      className="block bg-white p-3 rounded-lg border border-gray-200 hover:border-gray-300 hover:shadow-sm transition-all cursor-pointer"
    >
      <div className="font-medium mb-1 text-gray-800 text-sm break-words line-clamp-2 leading-6" title={task.title}>
        {task.title}
      </div>

      {/* Iteration + Score */}
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-2">
          {task.iterationCount !== undefined && (
            <span className="text-[10px] font-medium text-gray-400">
              Iter {task.iterationCount}/5
            </span>
          )}
          {latestEval?.overallScore !== undefined && (
            <span className={`text-xs font-bold ${scoreColor(latestEval.overallScore)}`}>
              {latestEval.overallScore}/100
            </span>
          )}
        </div>
        {latestEval?.decision && (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${decisionColors[latestEval.decision] || "bg-gray-100 text-gray-500 border-gray-200"}`}>
            {latestEval.decision}
          </span>
        )}
      </div>

      {/* Gate strip */}
      {latestEval?.gates && (
        <div className="mt-2">
          <GateGrid gates={latestEval.gates} compact />
        </div>
      )}

      {/* Score sparkline */}
      {scores.length > 1 && (
        <div className="mt-2">
          <ScoreSparkline scores={scores} height={24} width={100} />
        </div>
      )}

      {/* Agent badge */}
      <div className="flex justify-between items-center mt-2">
        {task.assignedTo && (
          <div className="flex items-center gap-1.5 text-xs text-gray-700 bg-gray-50 border border-gray-200 px-2 py-1 rounded-md font-medium">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            @{typeof task.assignedTo === "string" ? task.assignedTo : task.assignedTo[0]}
          </div>
        )}
        <div className={`w-2 h-2 rounded-full ${
          task.status === "done" ? "bg-green-500" :
          task.status === "in_progress" ? "bg-yellow-500" :
          task.status === "review" ? "bg-purple-500" : "bg-gray-300"
        }`} />
      </div>
    </Link>
  );
}

export default function MirrorDashboard() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const allTasks = useQuery(api.tasks.list) as Task[] | undefined;

  const mirrorTasks = useMemo(
    () => (allTasks || []).filter(t => t.pipelineType === "frontend-mirror"),
    [allTasks]
  );

  const columns = useMemo(() => {
    const inbox = mirrorTasks.filter(t => t.status === "inbox");
    const working = mirrorTasks.filter(t => t.status === "assigned" || t.status === "in_progress");
    const review = mirrorTasks.filter(t => t.status === "review");
    const done = mirrorTasks.filter(t => t.status === "done").reverse();

    const cols: Array<[string, Task[]]> = [
      ["working", working],
      ["review", review],
      ["done", done],
    ];

    return inbox.length > 0 ? [["inbox", inbox] as [string, Task[]], ...cols] : cols;
  }, [mirrorTasks]);

  const colLabel = (id: string) => id.replace("_", " ");

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-[1600px] mx-auto space-y-8 font-sans bg-white text-black">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 border-b border-gray-200 pb-6 gap-4">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-gray-400 hover:text-gray-600 transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-black mb-1">War Loops</h1>
            <p className="text-gray-500 text-sm">Autonomous frontend designer: source → spec → wireframe → production code</p>
          </div>
        </div>
        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 bg-black text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-gray-800 transition-colors"
        >
          <Plus size={16} />
          New Mirror Task
        </button>
      </header>

      {/* Agents Row */}
      <section>
        <h2 className="font-semibold mb-4 text-gray-400 uppercase tracking-widest text-xs">Design Squad</h2>
        <MirrorSquad />
      </section>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">

        {/* Task Board (Left - 3 cols) */}
        <section className="lg:col-span-3 h-[calc(100vh-340px)] flex flex-col">
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-semibold text-gray-400 uppercase tracking-widest text-xs">Mission Queue</h2>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-400">
                {mirrorTasks.length} task{mirrorTasks.length !== 1 ? "s" : ""}
              </span>
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            <div className="grid gap-3 h-full" style={{ gridTemplateColumns: `repeat(${columns.length}, 1fr)` }}>
              {columns.map(([id, items]) => (
                <div key={id} className="bg-gray-50 rounded-xl p-3 flex flex-col h-full max-h-full border border-gray-200 overflow-hidden">
                  <h3 className="uppercase text-xs font-semibold text-gray-400 mb-3 tracking-wider flex items-center gap-2 flex-shrink-0">
                    {colLabel(id)}
                    <span className="bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full text-xs">{items.length}</span>
                  </h3>
                  <div className="space-y-2 overflow-y-auto flex-1 pr-1 custom-scrollbar">
                    {items.length === 0 && (
                      <div className="text-gray-400 text-xs text-center py-4">Empty</div>
                    )}
                    {items.map((task) => (
                      <MirrorTaskCard key={task._id} task={task} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Live Feed (Right - 1 col) */}
        <section className="h-[calc(100vh-340px)] flex flex-col">
          <h2 className="font-semibold mb-4 text-gray-400 uppercase tracking-widest text-xs">Live Console</h2>
          <div className="flex-1 overflow-hidden">
            <ActivityFeed />
          </div>
        </section>

      </div>

      <NewMirrorTaskModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </div>
  );
}
