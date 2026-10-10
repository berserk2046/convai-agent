import type { Metadata } from "next";
import { publishedTemplates } from "@platform/services";
import { Alert, Card, CardContent, PageHeader } from "../../../../components/ui.tsx";
import { services } from "../../../../lib/server.ts";
import { requireOwnerPage } from "../../../../lib/session.ts";
import { NewBusinessForm } from "./new-business-form.tsx";

export const metadata: Metadata = { title: "New business" };

export default async function NewBusinessPage() {
  const actor = await requireOwnerPage();
  const templates = await publishedTemplates(services(), actor);
  return (
    <>
      <PageHeader
        title="New business"
        description="Pinned to a published template version. Its admin fills in the business data later (setup)."
      />
      <Card>
        <CardContent>
          {templates.length === 0 ? (
            <Alert variant="warning">Publish a template first.</Alert>
          ) : (
            <NewBusinessForm templates={templates} />
          )}
        </CardContent>
      </Card>
    </>
  );
}
