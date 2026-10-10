"use client";

import { ConfigForm } from "../../../../../../components/config-form.tsx";
import { upgradeAction } from "../../../actions.ts";

export function UpgradeForm({
  businessId,
  version,
  schema,
  uiSchema,
  config,
}: {
  businessId: string;
  version: string;
  schema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  config: Record<string, unknown>;
}) {
  return (
    <ConfigForm
      schema={schema}
      uiSchema={uiSchema}
      initial={config}
      submitLabel={`Upgrade to ${version}`}
      onSave={async (data) => {
        const result = await upgradeAction(businessId, version, data);
        return {
          ok: result.ok,
          message: result.message,
          errors: (result.errors ?? []).map((e) => ({
            path: e.path.split(/[.[\]]+/).filter(Boolean),
            message: e.message,
          })),
        };
      }}
    />
  );
}
