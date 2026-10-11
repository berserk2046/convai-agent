import type { Metadata } from "next";
import Link from "next/link";
import { listPlaygrounds, playgroundOptions } from "@platform/services";
import { dollars } from "../../../components/evals.tsx";
import {
  Alert,
  Badge,
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
import { StartForm } from "./start-form.tsx";

export const metadata: Metadata = { title: "Playground" };

export default async function PlaygroundPage(props: PageProps<"/playground">) {
  const actor = await requireOwnerPage();
  const [options, sessions] = await Promise.all([
    playgroundOptions(services(), actor),
    listPlaygrounds(services(), actor),
  ]);
  const template = (await props.searchParams).template;
  return (
    <>
      <PageHeader
        title="Playground"
        description="Chat with a template as a customer would. The real agent answers in a sandbox: you see its tool calls, tokens and cost, and nothing goes to WhatsApp."
      />
      <div className="grid gap-6">
        <Card>
          <CardHeader title="New chat" />
          <CardContent className="grid gap-4">
            {options.unavailable ? <Alert variant="warning">{options.unavailable}</Alert> : null}
            <StartForm
              options={options}
              initialTemplate={typeof template === "string" ? template : null}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader
            title="Chats"
            description="A chat nobody uses for a day ends on its own; its transcript stays here."
          />
          {sessions.length === 0 ? (
            <Empty>No chats yet.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Last used</Th>
                  <Th>Template</Th>
                  <Th>Business data</Th>
                  <Th>Messages</Th>
                  <Th>Cost</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <Td className="text-muted-foreground">{ownerDateTime(s.lastUsedAt)}</Td>
                    <Td className="font-mono">{s.template}</Td>
                    <Td>{s.config}</Td>
                    <Td>{s.messages}</Td>
                    <Td>{dollars(s.costUsd)}</Td>
                    <Td>
                      <Link className="underline" href={`/playground/${s.id}`}>
                        Open
                      </Link>{" "}
                      {s.status === "closed" ? <Badge variant="outline">ended</Badge> : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
