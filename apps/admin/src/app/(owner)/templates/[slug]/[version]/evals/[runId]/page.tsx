import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import type { RunReport, ScenarioReport } from "@platform/evals";
import { NotFoundError, evalRunDetail } from "@platform/services";
import { AutoRefresh } from "../../../../../../../components/auto-refresh.tsx";
import { ChatBubble, ToolCalls } from "../../../../../../../components/chat.tsx";
import {
  EvalRunBadge,
  RunStatusBadge,
  dollars,
  percent,
} from "../../../../../../../components/evals.tsx";
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  PageHeader,
  Table,
  Td,
  Th,
} from "../../../../../../../components/ui.tsx";
import { ownerDateTime } from "../../../../../../../lib/format.ts";
import { services } from "../../../../../../../lib/server.ts";
import { requireOwnerPage } from "../../../../../../../lib/session.ts";

export const metadata: Metadata = { title: "Eval run" };

export default async function EvalRunPage(
  props: PageProps<"/templates/[slug]/[version]/evals/[runId]">,
) {
  const actor = await requireOwnerPage();
  const { slug, version, runId } = await props.params;
  const detail = await evalRunDetail(services(), actor, runId).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  if (detail.slug !== slug || detail.version !== version) notFound();
  const { run, report } = detail;
  const back = `/templates/${slug}/${version}`;
  return (
    <>
      {run.status === "queued" || run.status === "running" ? <AutoRefresh /> : null}
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Eval run <EvalRunBadge status={run.status} gatePassed={run.gatePassed} />
          </span>
        }
        description={
          <>
            <Link className="underline" href={back}>
              {slug}@{version}
            </Link>{" "}
            · {run.mode} · {run.runsPerScenario} run(s) per scenario · started{" "}
            {ownerDateTime(run.createdAt)}
            {run.current ? "" : " · evaluated an earlier upload of this draft"}
          </>
        }
      />
      <div className="grid gap-6">
        {run.status === "queued" || run.status === "running" ? (
          <Alert>
            {run.progress
              ? `${String(run.progress.done)} of ${String(run.progress.total)} scenario runs done.`
              : "Waiting for the worker."}{" "}
            The report appears when the run finishes.
          </Alert>
        ) : null}
        {run.error ? <Alert variant="destructive">{run.error}</Alert> : null}
        {report ? (
          <>
            <Card>
              <CardHeader
                title="Summary"
                description={`Agent ${report.agentModel}, judge ${report.judgeModel}.`}
              />
              <CardContent>
                <dl className="grid gap-4 text-sm sm:grid-cols-4">
                  <Stat label="Pass rate">
                    {percent(report.summary.passRate)} ({report.summary.passedRuns}/
                    {report.summary.totalRuns} runs)
                  </Stat>
                  <Stat label="Critical scenarios">
                    {report.summary.criticalPass
                      ? "all passed"
                      : `failed: ${report.summary.failingCritical.join(", ")}`}
                  </Stat>
                  <Stat label="Gate">{report.summary.gatePassed ? "passed" : "failed"}</Stat>
                  <Stat label="Cost">{dollars(report.costUsd)}</Stat>
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader title="Scenarios" />
              <Table>
                <thead>
                  <tr>
                    <Th>Scenario</Th>
                    <Th>Runs</Th>
                    <Th>First problem</Th>
                  </tr>
                </thead>
                <tbody>
                  {report.scenarios.map((s) => (
                    <tr key={s.id}>
                      <Td>
                        <a className="font-mono underline" href={`#${s.id}`}>
                          {s.id}
                        </a>{" "}
                        {s.critical ? <Badge variant="outline">critical</Badge> : null}
                      </Td>
                      <Td>
                        <span className="flex gap-1">
                          {s.runs.map((r) => (
                            <RunStatusBadge key={r.run} status={r.status} />
                          ))}
                        </span>
                      </Td>
                      <Td className="text-muted-foreground">{firstProblem(s) ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            {report.scenarios.map((s) => (
              <ScenarioDetails key={s.id} scenario={s} />
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function firstProblem(scenario: ScenarioReport): string | null {
  for (const run of scenario.runs) {
    if (run.status === "passed") continue;
    if (run.error) return `Run ${String(run.run)}: ${run.error}`;
    const failed = run.assertions.find((a) => !a.passed);
    if (failed) return `Run ${String(run.run)}: ${failed.name}: ${failed.detail}`;
  }
  return null;
}

function ScenarioDetails({ scenario }: { scenario: ScenarioReport }) {
  const allPassed = scenario.passedRuns === scenario.runs.length;
  return (
    <details
      id={scenario.id}
      open={!allPassed}
      className="scroll-mt-20 rounded-lg border border-border bg-card"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-5 py-3 text-sm font-medium">
        <span className="font-mono">{scenario.id}</span>
        {scenario.critical ? <Badge variant="outline">critical</Badge> : null}
        <span className="text-muted-foreground">
          {scenario.passedRuns}/{scenario.runs.length} passed
        </span>
      </summary>
      <div className="grid gap-6 border-t border-border px-5 py-4">
        {scenario.runs.map((run) => (
          <RunDetails key={run.run} run={run} />
        ))}
      </div>
    </details>
  );
}

function RunDetails({ run }: { run: RunReport }) {
  return (
    <section className="grid gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        Run {run.run} <RunStatusBadge status={run.status} />
        <span className="font-normal text-muted-foreground">
          {dollars(run.costUsd)} · {(run.durationMs / 1000).toFixed(1)} s · {run.usage.input} in /{" "}
          {run.usage.output} out tokens
        </span>
      </h3>
      {run.error ? <Alert variant="destructive">{run.error}</Alert> : null}
      {run.assertions.length > 0 ? (
        <ul className="grid gap-1 text-sm">
          {run.assertions.map((a, i) => (
            <li key={i} className={a.passed ? "" : "text-destructive"}>
              {a.passed ? "✓" : "✗"} <span className="font-mono text-xs">{a.name}</span> {a.detail}
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="grid gap-3 rounded-md border border-border p-3">
        {run.transcript.flatMap((turn, i) => [
          <ChatBubble key={`u${String(i)}`} side="in" meta={`Customer · ${turn.at.slice(11, 16)}`}>
            {turn.user}
          </ChatBubble>,
          <ToolCalls key={`t${String(i)}`} calls={turn.toolCalls} />,
          ...turn.replies.map((reply, j) => (
            <ChatBubble
              key={`r${String(i)}-${String(j)}`}
              side="out"
              meta={reply.kind === "fixed" ? "Template text" : "Assistant"}
            >
              {reply.body}
            </ChatBubble>
          )),
        ])}
      </ul>
      {run.logs.some((l) => l.level !== "info") ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Runtime warnings</summary>
          <ul className="mt-1 grid gap-0.5 font-mono">
            {run.logs
              .filter((l) => l.level !== "info")
              .map((l, i) => (
                <li key={i}>
                  {l.level} {l.alert ? `[${l.alert}] ` : ""}
                  {l.msg}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
