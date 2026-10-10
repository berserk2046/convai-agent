import type { Metadata } from "next";
import Link from "next/link";
import { listTemplates } from "@platform/services";
import { StatusBadge } from "../../../components/diff-view.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  Empty,
  PageHeader,
  Table,
  Td,
  Th,
} from "../../../components/ui.tsx";
import { ownerDateTime } from "../../../lib/format.ts";
import { services } from "../../../lib/server.ts";
import { requireOwnerPage } from "../../../lib/session.ts";
import { UploadForm } from "./upload-form.tsx";

export const metadata: Metadata = { title: "Templates" };

export default async function TemplatesPage() {
  const actor = await requireOwnerPage();
  const templates = await listTemplates(services(), actor);
  return (
    <>
      <PageHeader
        title="Vertical templates"
        description="Upload a template, review what changed, and publish it for businesses to use."
      />
      <div className="grid gap-6">
        <Card>
          <CardHeader title="Versions" />
          {templates.length === 0 ? (
            <Empty>No templates yet. Upload one below.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Template</Th>
                  <Th>Version</Th>
                  <Th>Status</Th>
                  <Th>Uploaded</Th>
                </tr>
              </thead>
              <tbody>
                {templates.flatMap((t) =>
                  t.versions.map((v) => (
                    <tr key={`${t.slug}@${v.version}`}>
                      <Td>
                        <span className="font-medium">{t.name}</span>{" "}
                        <span className="font-mono text-xs text-muted-foreground">{t.slug}</span>
                      </Td>
                      <Td>
                        <Link
                          className="font-mono underline"
                          href={`/templates/${t.slug}/${v.version}`}
                        >
                          {v.version}
                        </Link>
                      </Td>
                      <Td>
                        <StatusBadge status={v.status} />
                      </Td>
                      <Td className="text-muted-foreground">{ownerDateTime(v.createdAt)}</Td>
                    </tr>
                  )),
                )}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader
            title="Upload"
            description="Validated on upload (spec §10): errors show their YAML line and path. A version that's already published can't be replaced."
          />
          <CardContent>
            <UploadForm />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
