import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NotFoundError, templateDetail, type TemplateDetail } from "@platform/services";
import { AutoRefresh } from "../../../../../components/auto-refresh.tsx";
import { DiffView, StatusBadge } from "../../../../../components/diff-view.tsx";
import { EvalRunBadge, dollars, percent } from "../../../../../components/evals.tsx";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Empty,
  PageHeader,
  Table,
  Td,
  Th,
} from "../../../../../components/ui.tsx";
import { ownerDateTime } from "../../../../../lib/format.ts";
import { services } from "../../../../../lib/server.ts";
import { requireOwnerPage } from "../../../../../lib/session.ts";
import { deprecateAction } from "../../actions.ts";
import { PublishForm, RunEvalsForm } from "./forms.tsx";

export const metadata: Metadata = { title: "Template version" };

export default async function TemplateVersionPage(props: PageProps<"/templates/[slug]/[version]">) {
  const actor = await requireOwnerPage();
  const { slug, version } = await props.params;
  const detail = await templateDetail(services(), actor, slug, version).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {detail.name} <span className="font-mono text-lg">{detail.version}</span>
            <StatusBadge status={detail.status} />
          </span>
        }
        description={detail.description}
        actions={
          <div className="flex items-start gap-2">
            {detail.status === "draft" ? (
              <PublishForm slug={slug} version={version} blocker={detail.evals.blocker} />
            ) : null}
            {detail.status === "published" ? (
              <form action={deprecateAction.bind(null, slug, version)}>
                <Button variant="outline">Deprecate</Button>
              </form>
            ) : null}
          </div>
        }
      />
      <div className="grid gap-6">
        <p className="text-sm text-muted-foreground">
          Uploaded {ownerDateTime(detail.createdAt)}
          {detail.publishedAt ? `, published ${ownerDateTime(detail.publishedAt)}` : ""}.{" "}
          {detail.businessesPinned} business(es) pinned to this version.{" "}
          <Link className="underline" href="/templates">
            All templates
          </Link>
          {" · "}
          <Link className="underline" href={`/playground?template=${slug}@${version}`}>
            Try it in the playground
          </Link>
        </p>
        <EvalsCard detail={detail} />
        {detail.warnings.length > 0 ? (
          <Card>
            <CardHeader title={`Warnings (${String(detail.warnings.length)})`} />
            <CardContent>
              <ul className="grid gap-1 text-sm">
                {detail.warnings.map((w, i) => (
                  <li key={i}>
                    <span className="font-mono text-xs">{w.path}</span> {w.message}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader
            title={detail.previous ? `Changes since ${detail.previous}` : "First version"}
            description="Sections as written in the YAML."
          />
          <CardContent>
            {detail.previous ? (
              <DiffView sections={detail.diff} />
            ) : (
              <p className="text-sm text-muted-foreground">Nothing to compare with.</p>
            )}
          </CardContent>
        </Card>
        <details className="rounded-lg border border-border bg-card">
          <summary className="cursor-pointer px-5 py-3 text-sm font-medium">Source YAML</summary>
          <pre className="overflow-x-auto border-t border-border px-5 py-3 text-xs leading-5">
            {detail.sourceYaml}
          </pre>
        </details>
      </div>
    </>
  );
}

function EvalsCard({ detail }: { detail: TemplateDetail }) {
  const { evals, scenarios } = detail;
  const critical = scenarios.filter((s) => s.critical).length;
  const active = evals.active;
  return (
    <Card>
      {active ? <AutoRefresh /> : null}
      <CardHeader
        title="Evals"
        description={`${String(scenarios.length)} scenarios, ${String(critical)} critical. A live run plays each scenario 3 times against Claude in a sandbox; nothing is sent to WhatsApp.`}
        actions={
          detail.status === "deprecated" ? null : (
            <RunEvalsForm slug={detail.slug} version={detail.version} disabled={active !== null} />
          )
        }
      />
      <CardContent className="grid gap-4">
        {active ? (
          <Alert>
            Eval run {active.status}
            {active.progress
              ? `: ${String(active.progress.done)} of ${String(active.progress.total)} scenario runs done.`
              : ". The worker picks it up within seconds."}
          </Alert>
        ) : detail.status !== "draft" ? null : evals.blocker ? (
          <Alert variant="warning">
            <strong>Not publishable yet.</strong> {evals.blocker} The gate: every critical scenario
            passes all 3 runs, and at least 90% of all runs pass.
          </Alert>
        ) : (
          <Alert variant="success">The latest live eval run of this upload passed the gate.</Alert>
        )}
      </CardContent>
      {evals.runs.length === 0 ? (
        <Empty>No eval runs yet.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Started</Th>
              <Th>Result</Th>
              <Th>Pass rate</Th>
              <Th>Critical</Th>
              <Th>Cost</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {evals.runs.map((run) => (
              <tr key={run.id}>
                <Td className="text-muted-foreground">
                  {ownerDateTime(run.createdAt)}
                  {run.current ? null : (
                    <Badge variant="outline" className="ml-2">
                      earlier upload
                    </Badge>
                  )}
                </Td>
                <Td>
                  <EvalRunBadge status={run.status} gatePassed={run.gatePassed} />
                  {run.error ? (
                    <p className="mt-1 max-w-xs text-xs text-destructive">{run.error}</p>
                  ) : null}
                </Td>
                <Td>{percent(run.passRate)}</Td>
                <Td>
                  {run.criticalPass === null ? "—" : run.criticalPass ? "all passed" : "failed"}
                </Td>
                <Td>{dollars(run.costUsd)}</Td>
                <Td>
                  {run.status === "finished" || run.status === "running" ? (
                    <Link
                      className="underline"
                      href={`/templates/${detail.slug}/${detail.version}/evals/${run.id}`}
                    >
                      Report
                    </Link>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
