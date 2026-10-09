/**
 * Quick-reply payloads (spec §9): `<rule_key>:<run_id>:<payload>`, so a tap finds the run
 * that sent the template and the rule's `on_button.<payload>` actions.
 */

export interface ButtonPayload {
  ruleKey: string;
  runId: string;
  payload: string;
}

const PAYLOAD = /^([a-z][a-z0-9_]*):([0-9a-f-]{36}):([a-z][a-z0-9_]*)$/;

export function encodeButtonPayload(p: ButtonPayload): string {
  return `${p.ruleKey}:${p.runId}:${p.payload}`;
}

export function decodeButtonPayload(text: string): ButtonPayload | null {
  const match = PAYLOAD.exec(text);
  if (!match) return null;
  const [, ruleKey = "", runId = "", payload = ""] = match;
  return { ruleKey, runId, payload };
}
