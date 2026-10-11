import { createHash } from "node:crypto";
import type { Anthropic, LlmClient } from "@platform/llm";
import { z } from "zod";

/**
 * Record/replay for evals (spec §11, `EVAL_LLM=replay`, ADR 0015). A live run can record
 * every LLM response; a replay run returns them without calling the API, so CI runs the
 * evals fast and for free.
 *
 * Each response is filed under a hash of the request that produced it. Any change to the
 * prompt, the tools, the template text or the conversation changes the hash, and replay
 * stops with a "re-record" error instead of answering a question nobody asked
 * (spec review B33).
 *
 * Database ids differ on every run, and they appear in requests (tool results, proposal
 * ids in the context) and in responses (the model passes a booking id back). So before
 * hashing, each UUID becomes `<uuid:N>`, numbered by first appearance in the run; a
 * replayed response gets this run's ids back in the same places.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PLACEHOLDER = /<uuid:(\d+)>/g;

/** Maps one run's UUIDs to placeholders and back. */
export class UuidNormalizer {
  readonly #toPlaceholder = new Map<string, string>();
  readonly #toUuid = new Map<string, string>();

  normalize<T>(value: T): T {
    const json = JSON.stringify(value).replace(UUID, (uuid) => this.#placeholder(uuid));
    return JSON.parse(json) as T;
  }

  restore<T>(value: T): T {
    const json = JSON.stringify(value).replace(PLACEHOLDER, (placeholder) =>
      this.#uuid(placeholder),
    );
    return JSON.parse(json) as T;
  }

  #placeholder(uuid: string): string {
    const key = uuid.toLowerCase();
    let placeholder = this.#toPlaceholder.get(key);
    if (!placeholder) {
      placeholder = `<uuid:${String(this.#toPlaceholder.size + 1)}>`;
      this.#toPlaceholder.set(key, placeholder);
      this.#toUuid.set(placeholder, key);
    }
    return placeholder;
  }

  /** A placeholder this run hasn't seen (an id the model made up) gets a stable fake id. */
  #uuid(placeholder: string): string {
    const known = this.#toUuid.get(placeholder);
    if (known) return known;
    const n = placeholder.replace(/\D/g, "").padStart(12, "0");
    const fake = `00000000-0000-4000-8000-${n}`;
    this.#toUuid.set(placeholder, fake);
    this.#toPlaceholder.set(fake, placeholder);
    return fake;
  }
}

/** JSON with object keys sorted, so equal requests always hash the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function requestKey(
  params: Anthropic.MessageCreateParamsNonStreaming,
  normalizer: UuidNormalizer,
): string {
  return createHash("sha256")
    .update(canonicalJson(normalizer.normalize(params)))
    .digest("hex");
}

export interface RecordedCall {
  /** requestKey() of the request. */
  key: string;
  /** The response with this run's UUIDs as placeholders and no message id. */
  response: Omit<Anthropic.Message, "id">;
}

/** One scenario's recorded calls (agent turns and judge), in call order. */
export interface ScenarioRecording {
  calls: RecordedCall[];
}

/** `templates/<slug>/eval-recordings.json`. */
export interface RecordingFile {
  format: 1;
  /** "slug@version" the recordings were made with. */
  template: string;
  recordedAt: string;
  scenarios: Record<string, ScenarioRecording>;
}

const recordingFile = z.object({
  format: z.literal(1),
  template: z.string(),
  recordedAt: z.string(),
  scenarios: z.record(
    z.string(),
    z.object({
      calls: z.array(z.object({ key: z.string(), response: z.record(z.string(), z.unknown()) })),
    }),
  ),
});

/** A recording file's contents, or null if it isn't one. */
export function parseRecordingFile(value: unknown): RecordingFile | null {
  const parsed = recordingFile.safeParse(value);
  return parsed.success ? (parsed.data as unknown as RecordingFile) : null;
}

/** Calls the live API and keeps each response, normalized, in `sink`. */
export function recordingLlm(live: LlmClient, sink: RecordedCall[]): LlmClient {
  const normalizer = new UuidNormalizer();
  return {
    async createMessage(params) {
      const key = requestKey(params, normalizer);
      const response = await live.createMessage(params);
      const { id: _id, ...rest } = response;
      sink.push({ key, response: normalizer.normalize(rest) });
      return response;
    },
  };
}

/** Replay had no recorded response for a request: the recordings are stale. */
export class ReplayMissError extends Error {
  constructor(scenario: string, call: number) {
    super(
      `no recorded response for LLM call ${String(call)} of "${scenario}": the prompt, the tools ` +
        "or a reply changed since the recordings were made. Re-record with --record (live).",
    );
    this.name = "ReplayMissError";
  }
}

/** Answers from a scenario's recording; each recorded response is used once. */
export function replayLlm(recording: ScenarioRecording | undefined, scenario: string): LlmClient {
  const normalizer = new UuidNormalizer();
  const used = new Set<number>();
  let calls = 0;
  return {
    createMessage(params) {
      calls += 1;
      const key = requestKey(params, normalizer);
      const index = (recording?.calls ?? []).findIndex((c, i) => !used.has(i) && c.key === key);
      const call = recording?.calls[index];
      if (!call) return Promise.reject(new ReplayMissError(scenario, calls));
      used.add(index);
      const restored = normalizer.restore(call.response);
      return Promise.resolve({
        id: `msg_replay_${String(calls)}`,
        ...restored,
      } as Anthropic.Message);
    },
  };
}
