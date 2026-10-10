import type { Metadata } from "next";
import Link from "next/link";
import { listBusinesses } from "@platform/services";
import {
  Badge,
  Card,
  Empty,
  PageHeader,
  Table,
  Td,
  Th,
  buttonClass,
} from "../../../components/ui.tsx";
import { ownerDateTime } from "../../../lib/format.ts";
import { services } from "../../../lib/server.ts";
import { requireOwnerPage } from "../../../lib/session.ts";

export const metadata: Metadata = { title: "Businesses" };

const STATUS: Partial<Record<string, "success" | "warning" | "outline">> = {
  active: "success",
  setup: "warning",
  paused: "outline",
};

export default async function BusinessesPage() {
  const actor = await requireOwnerPage();
  const businesses = await listBusinesses(services(), actor);
  return (
    <>
      <PageHeader
        title="Businesses"
        actions={
          <Link className={buttonClass()} href="/businesses/new">
            New business
          </Link>
        }
      />
      <Card>
        {businesses.length === 0 ? (
          <Empty>No businesses yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Template</Th>
                <Th>WhatsApp</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {businesses.map((b) => (
                <tr key={b.id}>
                  <Td>
                    <Link className="font-medium underline" href={`/businesses/${b.id}`}>
                      {b.name}
                    </Link>
                  </Td>
                  <Td>
                    <Badge variant={STATUS[b.status] ?? "default"}>{b.status}</Badge>
                  </Td>
                  <Td className="font-mono text-xs">{b.template}</Td>
                  <Td>
                    {b.displayPhone ?? <span className="text-muted-foreground">not connected</span>}
                  </Td>
                  <Td className="text-muted-foreground">{ownerDateTime(b.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
