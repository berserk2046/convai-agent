import type { EvalMode } from "@platform/db";
import type { TokenUsage } from "@platform/llm";
import type { AssertionResult } from "./assertions.ts";
import type { SandboxState } from "./sandbox.ts";

/**
 * What an eval run produces (stored in `eval_runs.results`), and the publish gate
 * (spec §10): every run of every critical scenario passes, and at least 90% of all runs
 * pass. Only a complete live run with 3 runs per scenario can unlock publishing
 * (spec review B33): replay recordings are for CI.
 */

export const GATE_MIN_PASS_RATE = 0.9;
/** Live runs per scenario (spec §11: a critical scenario must pass all 3). */
export const LIVE_RUNS_PER_SCENARIO = 3;
/** Spec §11: without `clock`, scenarios run on this Monday morning in Bogotá. */
export const DEFAULT_EVAL_CLOCK = "2026-10-05T09:00:00-05:00";

export type RunStatus = "passed" | "failed" | "error";

export interface TranscriptTurn {
  /** Mock-clock time of the message, business-local ISO. */
  at: string;
  user: string;
  replies: { body: string; kind: string }[];
  toolCalls: { name: string; input: unknown; result: unknown; isError: boolean }[];
  costUsd: number;
}

export interface LogEntry {
  level: "info" | "warn" | "error";
  msg: string;
  alert?: string;
}

export interface RunReport {
  /** 1-based. */
  run: number;
  status: RunStatus;
  /** For "error": what went wrong outside the agent (API failure, stale recording). */
  error: string | null;
  assertions: AssertionResult[];
  transcript: TranscriptTurn[];
  finalState: SandboxState | null;
  usage: TokenUsage;
  costUsd: number;
  durationMs: number;
  /** The runtime's own log lines (info and above), for debugging a failure. */
  logs: LogEntry[];
}

export interface ScenarioReport {
  id: string;
  critical: boolean;
  passedRuns: number;
  runs: RunReport[];
}

export interface GateSummary {
  totalRuns: number;
  passedRuns: number;
  passRate: number;
  /** Every run of every critical scenario passed. */
  criticalPass: boolean;
  /** Critical scenarios with a run that didn't pass. */
  failingCritical: string[];
  /** criticalPass, pass rate ≥ 90%, and every scenario ran (no --only). */
  gatePassed: boolean;
}

export interface EvalReport {
  format: 1;
  template: { slug: string; version: string; sourceSha256: string };
  mode: EvalMode;
  runsPerScenario: number;
  /** Scenario ids when only some ran (then the gate can't pass). */
  only: string[] | null;
  agentModel: string;
  judgeModel: string;
  startedAt: string;
  finishedAt: string;
  summary: GateSummary;
  usage: TokenUsage;
  costUsd: number;
  scenarios: ScenarioReport[];
}

export function gateSummary(scenarios: readonly ScenarioReport[], complete: boolean): GateSummary {
  const totalRuns = scenarios.reduce((n, s) => n + s.runs.length, 0);
  const passedRuns = scenarios.reduce((n, s) => n + s.passedRuns, 0);
  const passRate = totalRuns === 0 ? 0 : passedRuns / totalRuns;
  const failingCritical = scenarios
    .filter((s) => s.critical && s.runs.some((r) => r.status !== "passed"))
    .map((s) => s.id);
  const criticalPass = failingCritical.length === 0;
  return {
    totalRuns,
    passedRuns,
    passRate,
    criticalPass,
    failingCritical,
    gatePassed: complete && totalRuns > 0 && criticalPass && passRate >= GATE_MIN_PASS_RATE,
  };
}

export interface GateInput {
  status: string;
  mode: EvalMode;
  runsPerScenario: number;
  gatePassed: boolean | null;
  passRate: number | null;
  criticalPass: boolean | null;
}

/** Why this run can't unlock publishing, or null when it can. Messages are for the owner. */
export function publishBlocker(run: GateInput | null): string | null {
  if (!run) {
    return "Run the evals first: publishing needs a live eval run of this upload.";
  }
  if (run.status !== "finished") return "The latest eval run hasn't finished.";
  if (run.mode !== "live") return "Publishing needs a live eval run; replay runs are for CI.";
  if (run.runsPerScenario < LIVE_RUNS_PER_SCENARIO) {
    return `Publishing needs ${String(LIVE_RUNS_PER_SCENARIO)} runs per scenario.`;
  }
  if (run.gatePassed) return null;
  if (run.criticalPass === false) {
    return "A critical eval failed in the latest run: every run of every critical scenario must pass.";
  }
  const rate = run.passRate === null ? "?" : `${(run.passRate * 100).toFixed(0)}%`;
  return `The latest eval run passed ${rate} of runs; publishing needs ${String(GATE_MIN_PASS_RATE * 100)}%.`;
}
