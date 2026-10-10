"use client";

import { useActionState } from "react";
import { FormMessage, Submit } from "../../../../components/form-bits.tsx";
import { Field, Input, Select } from "../../../../components/ui.tsx";
import {
  activateAction,
  addUserAction,
  connectChannelAction,
  resetPasswordAction,
  settingsAction,
} from "../actions.ts";

export function ConnectChannelForm({
  businessId,
  connected,
}: {
  businessId: string;
  connected: boolean;
}) {
  const [state, action] = useActionState(connectChannelAction.bind(null, businessId), null);
  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Phone number ID" error={state?.fields?.phoneNumberId}>
          <Input name="phoneNumberId" inputMode="numeric" required />
        </Field>
        <Field label="WhatsApp Business Account ID" error={state?.fields?.wabaId}>
          <Input name="wabaId" inputMode="numeric" required />
        </Field>
        <Field label="Display phone" error={state?.fields?.displayPhone}>
          <Input name="displayPhone" placeholder="+57 300 000 0000" required />
        </Field>
        <Field
          label="Access token"
          hint="Encrypted at rest; never shown again."
          error={state?.fields?.accessToken}
        >
          <Input name="accessToken" type="password" autoComplete="off" required />
        </Field>
      </div>
      <FormMessage state={state} />
      <div>
        <Submit variant={connected ? "outline" : "default"} pendingText="Connecting…">
          {connected ? "Replace channel" : "Connect channel"}
        </Submit>
      </div>
    </form>
  );
}

export function AddUserForm({ businessId }: { businessId: string }) {
  const [state, action] = useActionState(addUserAction.bind(null, businessId), null);
  return (
    <form action={action} key={state?.ok ? state.at : undefined} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email" error={state?.fields?.email}>
          <Input name="email" type="email" required />
        </Field>
        <Field label="Name">
          <Input name="name" />
        </Field>
        <Field label="Role">
          <Select name="role" defaultValue="business_admin">
            <option value="business_admin">Business admin</option>
            <option value="business_staff">Staff (inbox and bookings)</option>
          </Select>
        </Field>
        <Field
          label="Temporary password"
          hint="New users only; 10+ characters."
          error={state?.fields?.password}
        >
          <Input name="password" type="text" autoComplete="off" />
        </Field>
      </div>
      <FormMessage state={state} />
      <div>
        <Submit pendingText="Adding…">Add user</Submit>
      </div>
    </form>
  );
}

export function ResetPasswordForm({ businessId, userId }: { businessId: string; userId: string }) {
  const [state, action] = useActionState(resetPasswordAction.bind(null, businessId, userId), null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <Input
        name="password"
        placeholder="New password"
        className="h-8 w-44 text-xs"
        autoComplete="off"
        required
      />
      <Submit size="sm" variant="outline">
        Set
      </Submit>
      <FormMessage state={state} className="text-xs" />
    </form>
  );
}

export function SettingsForm({
  businessId,
  name,
  llmUsdMonth,
  marketingMsgsMonth,
  planPriceUsd,
}: {
  businessId: string;
  name: string;
  llmUsdMonth: number | undefined;
  marketingMsgsMonth: number | undefined;
  planPriceUsd: number | null;
}) {
  const [state, action] = useActionState(settingsAction.bind(null, businessId), null);
  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" error={state?.fields?.name}>
          <Input name="name" defaultValue={name} required />
        </Field>
        <Field label="Plan price (USD / month)" error={state?.fields?.planPriceUsd}>
          <Input
            name="planPriceUsd"
            type="number"
            min="0"
            step="0.01"
            defaultValue={planPriceUsd ?? ""}
          />
        </Field>
        <Field
          label="Monthly AI cap (USD)"
          hint="Empty: platform default"
          error={state?.fields?.["limits.llm_usd_month"]}
        >
          <Input
            name="llmUsdMonth"
            type="number"
            min="0"
            step="0.01"
            defaultValue={llmUsdMonth ?? ""}
          />
        </Field>
        <Field
          label="Monthly marketing messages"
          hint="Empty: platform default"
          error={state?.fields?.["limits.marketing_msgs_month"]}
        >
          <Input
            name="marketingMsgsMonth"
            type="number"
            min="0"
            step="1"
            defaultValue={marketingMsgsMonth ?? ""}
          />
        </Field>
      </div>
      <FormMessage state={state} />
      <div>
        <Submit variant="outline" pendingText="Saving…">
          Save settings
        </Submit>
      </div>
    </form>
  );
}

export function ActivateForm({ businessId, ready }: { businessId: string; ready: boolean }) {
  const [state, action] = useActionState(activateAction.bind(null, businessId), null);
  return (
    <form action={action} className="grid gap-2">
      <div>
        <Submit disabled={!ready} pendingText="Activating…">
          Activate
        </Submit>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
