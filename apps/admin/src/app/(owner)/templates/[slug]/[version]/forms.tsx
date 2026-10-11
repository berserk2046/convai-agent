"use client";

import { useActionState } from "react";
import { FormMessage, Submit } from "../../../../../components/form-bits.tsx";
import { publishAction, runEvalsAction } from "../../actions.ts";

/** Publish, or the reason it's not possible yet (the eval gate, spec §10). */
export function PublishForm({
  slug,
  version,
  blocker,
}: {
  slug: string;
  version: string;
  blocker: string | null;
}) {
  const [state, action] = useActionState(publishAction.bind(null, slug, version), null);
  return (
    <form action={action} className="grid justify-items-end gap-1">
      <Submit disabled={blocker !== null} title={blocker ?? undefined} pendingText="Publishing…">
        Publish
      </Submit>
      <FormMessage state={state} className="max-w-sm text-right" />
    </form>
  );
}

export function RunEvalsForm({
  slug,
  version,
  disabled,
}: {
  slug: string;
  version: string;
  disabled: boolean;
}) {
  const [state, action] = useActionState(runEvalsAction.bind(null, slug, version), null);
  return (
    <form action={action} className="grid justify-items-end gap-1">
      <Submit variant="outline" disabled={disabled} pendingText="Queuing…">
        Run evals
      </Submit>
      <FormMessage state={state} className="max-w-sm text-right" />
    </form>
  );
}
