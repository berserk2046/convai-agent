import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NotFoundError, upgradePreview } from "@platform/services";
import { DiffView } from "../../../../../../components/diff-view.tsx";
import {
  Alert,
  Card,
  CardContent,
  CardHeader,
  PageHeader,
} from "../../../../../../components/ui.tsx";
import { isUuid } from "../../../../../../lib/ids.ts";
import { services } from "../../../../../../lib/server.ts";
import { requireOwnerPage } from "../../../../../../lib/session.ts";
import { UpgradeForm } from "./upgrade-form.tsx";

export const metadata: Metadata = { title: "Upgrade" };

/** Spec §10 upgrade: the diff, the config fields the new version needs, then pin it. */
export default async function UpgradePage(props: PageProps<"/businesses/[id]/upgrade/[version]">) {
  const actor = await requireOwnerPage();
  const { id, version } = await props.params;
  if (!isUuid(id)) notFound();
  const preview = await upgradePreview(services(), actor, id, version).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  return (
    <>
      <PageHeader
        title={`Upgrade ${preview.from} → ${preview.to}`}
        description={
          <Link className="underline" href={`/businesses/${id}`}>
            Back to the business
          </Link>
        }
      />
      <div className="grid gap-6">
        <Card>
          <CardHeader title="What changes" />
          <CardContent>
            <DiffView sections={preview.diff} />
          </CardContent>
        </Card>
        {preview.configErrors.length > 0 ? (
          <Alert variant="warning">
            The business config needs input for {preview.to}:{" "}
            {preview.configErrors.map((e) => `${e.path.join(".")} ${e.message}`).join("; ")}. Fill
            it in below; the upgrade saves the config and the new version together.
          </Alert>
        ) : (
          <Alert>The current config is valid for {preview.to}. Review it and upgrade.</Alert>
        )}
        <UpgradeForm
          businessId={id}
          version={version}
          schema={preview.form.schema}
          uiSchema={preview.form.uiSchema}
          config={preview.form.config}
        />
      </div>
    </>
  );
}
