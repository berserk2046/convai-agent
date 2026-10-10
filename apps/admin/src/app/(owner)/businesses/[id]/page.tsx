import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NotFoundError, businessDetail } from "@platform/services";
import { impersonateAction } from "../../../auth-actions.ts";
import {
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
} from "../../../../components/ui.tsx";
import { ownerDateTime } from "../../../../lib/format.ts";
import { isUuid } from "../../../../lib/ids.ts";
import { services } from "../../../../lib/server.ts";
import { requireOwnerPage } from "../../../../lib/session.ts";
import { pauseAction, removeUserAction } from "../actions.ts";
import {
  ActivateForm,
  AddUserForm,
  ConnectChannelForm,
  ResetPasswordForm,
  SettingsForm,
} from "./forms.tsx";

export const metadata: Metadata = { title: "Business" };

const META_STATUS: Partial<Record<string, "success" | "warning" | "destructive">> = {
  APPROVED: "success",
  PENDING: "warning",
  REJECTED: "destructive",
};

export default async function BusinessPage(props: PageProps<"/businesses/[id]">) {
  const actor = await requireOwnerPage();
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const detail = await businessDetail(services(), actor, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const { business } = detail;
  const ready = detail.checklist.every((c) => !c.required || c.done);
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {business.name}
            <Badge
              variant={
                business.status === "active"
                  ? "success"
                  : business.status === "setup"
                    ? "warning"
                    : "outline"
              }
            >
              {business.status}
            </Badge>
          </span>
        }
        description={
          <>
            <span className="font-mono">
              {business.templateSlug}@{business.templateVersion}
            </span>{" "}
            · {business.timezone} · created {ownerDateTime(business.createdAt)}
          </>
        }
        actions={
          <div className="flex gap-2">
            <form action={impersonateAction.bind(null, business.id)}>
              <Button variant="outline">Impersonate (set up as its admin)</Button>
            </form>
            {business.status === "active" ? (
              <form action={pauseAction.bind(null, business.id, true)}>
                <Button variant="outline">Pause</Button>
              </form>
            ) : null}
            {business.status === "paused" ? (
              <form action={pauseAction.bind(null, business.id, false)}>
                <Button variant="outline">Resume</Button>
              </form>
            ) : null}
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Activation checklist"
            description="Activation turns on automatic messages and records which WhatsApp templates Meta must approve."
          />
          <CardContent className="grid gap-4">
            <ul className="grid gap-2 text-sm">
              {detail.checklist.map((item) => (
                <li key={item.key} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={item.done ? "text-success" : "text-muted-foreground"}
                  >
                    {item.done ? "✓" : "○"}
                  </span>
                  <span className={item.done ? "" : "text-muted-foreground"}>{item.label}</span>
                  {!item.required ? <Badge variant="outline">recommended</Badge> : null}
                </li>
              ))}
            </ul>
            {business.status === "setup" ? (
              <ActivateForm businessId={business.id} ready={ready} />
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="WhatsApp channel"
            description={
              detail.channel
                ? `${detail.channel.displayPhone} · phone number ID ${detail.channel.phoneNumberId} · WABA ${detail.channel.wabaId}`
                : "Not connected. Enter the values from Meta's WhatsApp API setup page."
            }
          />
          <CardContent>
            <ConnectChannelForm businessId={business.id} connected={detail.channel !== null} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="Settings"
            description="Caps stop spending when reached (principle 10)."
          />
          <CardContent>
            <SettingsForm
              businessId={business.id}
              name={business.name}
              llmUsdMonth={business.limits.llm_usd_month}
              marketingMsgsMonth={business.limits.marketing_msgs_month}
              planPriceUsd={business.planPriceUsd}
            />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Users"
            description="Business admins see everything; staff see the inbox and bookings."
          />
          {detail.users.length > 0 ? (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Last login</Th>
                  <Th>Reset password</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {detail.users.map((u) => (
                  <tr key={u.userId}>
                    <Td>{u.name}</Td>
                    <Td>{u.email}</Td>
                    <Td>{u.role === "business_admin" ? "Admin" : "Staff"}</Td>
                    <Td className="text-muted-foreground">
                      {u.lastLoginAt ? ownerDateTime(u.lastLoginAt) : "never"}
                    </Td>
                    <Td>
                      <ResetPasswordForm businessId={business.id} userId={u.userId} />
                    </Td>
                    <Td>
                      <form action={removeUserAction.bind(null, business.id, u.userId)}>
                        <Button size="sm" variant="ghost">
                          Remove
                        </Button>
                      </form>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <Empty>No users yet.</Empty>
          )}
          <CardContent className="border-t border-border">
            <AddUserForm businessId={business.id} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="WhatsApp templates at Meta"
            description="Submitted by the worker when META_TEMPLATE_SUBMISSION=on. Only approved ones are sent."
          />
          {detail.waTemplates.length > 0 ? (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Category</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {detail.waTemplates.map((t) => (
                  <tr key={`${t.name}/${t.language}`}>
                    <Td className="font-mono text-xs">
                      {t.name} <span className="text-muted-foreground">({t.language})</span>
                    </Td>
                    <Td>{t.category}</Td>
                    <Td>
                      <Badge variant={META_STATUS[t.status ?? ""] ?? "outline"}>
                        {t.status ?? "not submitted"}
                      </Badge>
                      {t.rejectedReason ? (
                        <div className="text-xs text-destructive">{t.rejectedReason}</div>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <Empty>Recorded on activation.</Empty>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Template version"
            description={`Pinned to ${business.templateVersion}.`}
          />
          <CardContent>
            {detail.upgrades.length === 0 ? (
              <p className="text-sm text-muted-foreground">No newer published version.</p>
            ) : (
              <ul className="grid gap-2 text-sm">
                {detail.upgrades.map((v) => (
                  <li key={v}>
                    <Link className="underline" href={`/businesses/${business.id}/upgrade/${v}`}>
                      Review the upgrade to {v}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Recent activity" description="Audit log (spec §13)." />
          {detail.audit.length > 0 ? (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Who</Th>
                  <Th>What</Th>
                </tr>
              </thead>
              <tbody>
                {detail.audit.map((a, i) => (
                  <tr key={i}>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      {ownerDateTime(a.at)}
                    </Td>
                    <Td>{a.actor ?? "—"}</Td>
                    <Td>
                      <span className="font-mono text-xs">{a.action}</span>{" "}
                      <span className="text-xs text-muted-foreground">{summarize(a.payload)}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <Empty>Nothing yet.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}

function summarize(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  return text === "{}" ? "" : text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
