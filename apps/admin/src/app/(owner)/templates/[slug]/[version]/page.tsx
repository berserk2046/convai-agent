import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NotFoundError, templateDetail } from "@platform/services";
import { DiffView, StatusBadge } from "../../../../../components/diff-view.tsx";
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  PageHeader,
} from "../../../../../components/ui.tsx";
import { ownerDateTime } from "../../../../../lib/format.ts";
import { services } from "../../../../../lib/server.ts";
import { requireOwnerPage } from "../../../../../lib/session.ts";
import { deprecateAction, publishAction } from "../../actions.ts";

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
          <div className="flex gap-2">
            {detail.status === "draft" ? (
              <form action={publishAction.bind(null, slug, version)}>
                <Button>Publish</Button>
              </form>
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
        </p>
        {detail.status === "draft" ? (
          <Alert variant="warning">
            The eval gate (critical evals must pass) arrives with M6. Until then, publishing only
            needs a template that validates.
          </Alert>
        ) : null}
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
