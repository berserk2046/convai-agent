# 0015 — Evals: sandboxes, record/replay, the judge and the publish gate

Status: accepted (M6)

## Context

Spec §11 asks for:

- each template's eval scenarios run on the real agent runtime and tools, with a mock
  clock, a mock channel and a throwaway database;
- live LLM calls by default, plus record/replay for CI;
- a judge model for rubric assertions;
- the publish gate (§10): 100% of critical scenarios and at least 90% overall.

Runs are started from the admin, the CLI and CI.

## Decision

1. **One scratch database per eval run.**
   - The runner creates `eval_<time>_<random>` on the platform's Postgres server, migrates
     it, installs the template there, and drops the database at the end.
   - Every scenario run gets its own sandbox business in that database, so runs can go in
     parallel (4 at a time). Tenant isolation keeps them apart, as it does real businesses.
   - Scratch databases share code with the per-file test databases (`@platform/db`
     `scratch.ts`). The app's role needs `CREATEDB`; the compose superuser has it.
2. **The real pipeline, with fakes only at its edges.**
   - Each `user:` turn is built as a WhatsApp `InboundMessage` and goes through
     `ingestWebhookEvents`, then `processInboundBatch` with the agent responder, then
     delivery.
   - The fakes are a capturing WhatsApp client, the mock clock (one minute per message), and
     an event sink, because automations don't run in evals.
   - Turns run as "not the final attempt", and the metered LLM client records every failed
     call. An API failure or a replay miss therefore shows as an **error**, not as the
     agent's handoff.
   - The runtime's log lines are captured into the report: a sandbox's emergency alert is a
     test result, not an operator page.
3. **Record/replay by request hash.**
   - A recorded response is filed under the SHA-256 of its request (canonical JSON).
   - UUIDs are replaced by `<uuid:N>` in order of first appearance, both before hashing and
     in the stored response. Database ids differ every run, and the model passes them back
     (`booking_id`, `proposal_id`), so a replayed response gets this run's ids in the same
     places.
   - Any change to the prompt, tools, template text or conversation changes a hash. Replay
     then fails with "re-record" instead of answering a different question (spec review
     B33).
   - Recordings live next to the template in `eval-recordings.json`, one run per scenario
     (a passing one when there is one). CI replays every template that has them.
4. **The judge uses structured outputs.**
   - `JUDGE_MODEL` (default `claude-sonnet-5-5`) gets the conversation and the rubric, and
     answers through `output_config.format`: a JSON schema `{ pass, reason }`.
   - Sonnet 5.5 rejects a forced `tool_choice` (400), and the schema guarantees a parseable
     verdict.
   - A refusal or an unusable answer fails the assertion.
5. **Stored runs and the gate.**
   - `eval_runs` holds stored runs. It is platform-level and has no tenant grants.
   - Each run records the SHA-256 of the evaluated `source_yaml`. Re-uploading a draft
     makes its earlier runs stale.
   - The admin queues a live run of 3 runs per scenario. The worker claims runs one at a
     time (`FOR UPDATE SKIP LOCKED`, polling every 5 s), sends a heartbeat after each
     scenario run, and fails runs whose heartbeat is older than 15 minutes.
   - `pnpm template eval <slug>@<version>` runs the same code in place.
   - Publishing (admin or CLI) requires the latest finished **live** run of the current
     upload, with 3 runs per scenario, every critical run passing, and an overall pass rate
     of at least 90%. Replay runs never unlock publishing.
6. **The compiled-template cache is keyed by row id.** It used to be keyed by
   `slug@version`. A scratch database installs its own copy of a version, which may come
   from a different upload of the same draft. Keyed by version, the worker would have
   evaluated the old draft's prompt. The cache is also capped at 64 entries.
7. **The migrations folder path is built from parts.** The admin's Turbopack bundle tried
   to bundle `new URL("../migrations", import.meta.url)` as an asset and failed. It keeps
   `import.meta.url` pointing at the source file, so a path built from parts resolves
   correctly at runtime (checked with a production build).

## Consequences

- No live run has happened yet: there is no Anthropic key. Recordings for odontologia
  come from the first `pnpm template eval templates/odontologia --live --record`. Until
  then, CI prints a notice instead of replaying.
- A live odontologia run makes about 15 × 3 scenario runs, with 0 to 6 agent calls each and
  9 judge calls in all. On Haiku 5.5 (ADR 0017) that is roughly $0.10 per run; each report
  shows the exact cost, and `--max-cost` caps a CLI run. The nightly workflow therefore costs
  about $3 a month per template.
- Live evals aren't deterministic. The gate's 3 runs per scenario are the spec's answer;
  a flaky critical scenario blocks publishing until the prompt or the scenario is fixed.
- The eval business uses `sample_config` only (`eval_runs.config_source`). Running a
  template's evals against a real business's config would fail on scenarios that assert
  sample values (e.g. the emergency phone number), so it isn't offered.
