import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import {
  NotFoundError,
  playgroundDetail,
  playgroundOptions,
  type PlaygroundEntry,
} from "@platform/services";
import { ChatBubble, ToolCalls } from "../../../../components/chat.tsx";
import { dollars } from "../../../../components/evals.tsx";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  PageHeader,
} from "../../../../components/ui.tsx";
import { ownerDateTime } from "../../../../lib/format.ts";
import { services } from "../../../../lib/server.ts";
import { requireOwnerPage } from "../../../../lib/session.ts";
import { closeAction, deleteAction, returnToBotAction } from "../actions.ts";
import { Composer } from "./composer.tsx";

export const metadata: Metadata = { title: "Playground chat" };

export default async function PlaygroundSessionPage(props: PageProps<"/playground/[id]">) {
  const actor = await requireOwnerPage();
  const { id } = await props.params;
  const detail = await playgroundDetail(services(), actor, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const { unavailable } = await playgroundOptions(services(), actor);
  const active = detail.status === "active";
  const state = detail.state;
  const openHandoff = state?.handoffs.find((h) => h.open);
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Playground <span className="font-mono text-lg">{detail.template}</span>
            {active ? null : <Badge variant="outline">ended</Badge>}
          </span>
        }
        description={
          <>
            {detail.config} · {detail.model ?? "unknown model"} · started{" "}
            {ownerDateTime(detail.createdAt)} ·{" "}
            <Link className="underline" href="/playground">
              All chats
            </Link>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <Card>
          <CardHeader
            title="Conversation"
            description="Messages reach Claude for real (each turn shows its cost) but never WhatsApp."
          />
          <CardContent className="grid gap-4">
            <ul className="grid max-h-[65vh] gap-3 overflow-y-auto">
              {detail.entries.map((entry, i) => (
                <Entry key={i} entry={entry} />
              ))}
              <li id="transcript-end" />
            </ul>
            {unavailable && active ? <Alert variant="warning">{unavailable}</Alert> : null}
            {active ? (
              <Composer sessionId={detail.id} disabled={unavailable !== null} />
            ) : (
              <p className="text-sm text-muted-foreground">
                This chat has ended. Start a new one to keep testing.
              </p>
            )}
          </CardContent>
        </Card>
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader title="Sandbox" />
            <CardContent className="grid gap-3 text-sm">
              <Item label="Answering">
                {state?.mode === "human" ? "Staff (the bot is silent)" : "The bot"}
              </Item>
              {openHandoff ? (
                <div className="grid gap-2">
                  <Item label="Open handoff">{openHandoff.reason}</Item>
                  {active ? (
                    <form action={returnToBotAction.bind(null, detail.id)}>
                      <Button size="sm" variant="outline">
                        Close handoff, back to the bot
                      </Button>
                    </form>
                  ) : null}
                </div>
              ) : null}
              <Item label="Privacy notice">
                {state?.consentGiven ? "accepted" : "not accepted"}
              </Item>
              {state?.optedOut ? <Item label="Automatic messages">opted out</Item> : null}
              <Item label="Bookings">
                {state && state.bookings.length > 0 ? (
                  <ul className="grid gap-1">
                    {state.bookings.map((b) => (
                      <li key={b.id}>
                        {b.serviceName}, {b.label} · {b.subjectName}{" "}
                        <Badge variant={b.status === "cancelled" ? "outline" : "default"}>
                          {b.status}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  "none"
                )}
              </Item>
              <Item label="AI cost so far">{dollars(detail.costUsd)}</Item>
            </CardContent>
          </Card>
          {active ? (
            <form action={closeAction.bind(null, detail.id)}>
              <Button variant="outline" className="w-full">
                End chat
              </Button>
            </form>
          ) : (
            <form action={deleteAction.bind(null, detail.id)}>
              <Button variant="destructive" className="w-full">
                Delete chat
              </Button>
            </form>
          )}
        </div>
      </div>
    </>
  );
}

function Entry({ entry }: { entry: PlaygroundEntry }) {
  if (entry.type === "note") {
    return <li className="text-center text-xs text-muted-foreground">{entry.text}</li>;
  }
  const u = entry.usage;
  const warnings = entry.logs.filter((l) => l.level !== "info");
  return (
    <>
      <ChatBubble side="in" meta="Customer">
        {entry.user}
      </ChatBubble>
      <ToolCalls calls={entry.toolCalls} />
      {entry.replies.map((reply, j) => (
        <ChatBubble
          key={j}
          side="out"
          meta={reply.kind === "fixed" ? "Template text" : "Assistant"}
        >
          {reply.body}
        </ChatBubble>
      ))}
      {entry.error ? (
        <li>
          <Alert variant="destructive">This message wasn&apos;t answered: {entry.error}</Alert>
        </li>
      ) : null}
      <li className="justify-self-end text-right text-xs text-muted-foreground">
        {entry.replies.length === 0 && !entry.error ? "No reply (a person handles the chat). " : ""}
        {entry.toolCalls.length} tool call(s) · {u.input} in / {u.output} out tokens
        {u.cacheRead > 0 ? ` (${String(u.cacheRead)} cached)` : ""} · {dollars(entry.costUsd)}
        {entry.models.length > 0 ? ` · ${entry.models.join(", ")}` : ""}
        {entry.events.length > 0 ? ` · ${entry.events.join(", ")}` : ""}
        {warnings.map((w, i) => (
          <span key={i} className="block text-warning">
            {w.alert ? `[${w.alert}] ` : ""}
            {w.msg}
          </span>
        ))}
      </li>
    </>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}
