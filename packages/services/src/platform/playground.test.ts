import {
  claimPlaygroundTurn,
  createResource,
  getPlaygroundSession,
  listScratchDatabases,
} from "@platform/db";
import {
  ODONTOLOGIA_MODEL,
  ODONTOLOGIA_VERSION,
  laterVersion,
  odontologiaAt,
} from "@platform/db/testing";
import { fakeDentalLlm } from "@platform/evals/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../actor.ts";
import { ActionRefusedError, ForbiddenError } from "../errors.ts";
import { createHarness, type Harness } from "../harness.ts";
import {
  closePlayground,
  deletePlayground,
  listPlaygrounds,
  playgroundDetail,
  playgroundOptions,
  playgroundReturnToBot,
  playgroundSay,
  startPlayground,
  type PlaygroundEntry,
} from "./playground.ts";
import { uploadTemplate } from "./templates.ts";

let h: Harness;
let owner: Actor;
const llm = fakeDentalLlm();

beforeAll(async () => {
  h = await createHarness();
  h.deps.playground = { databaseUrl: h.core.testDb.url, llm };
  owner = await h.actor("owner@playground.co", { owner: true });
});

afterAll(async () => {
  for (const s of await listPlaygrounds(h.deps, owner)) await closePlayground(h.deps, owner, s.id);
  await h.close();
});

const turns = (entries: PlaygroundEntry[]) =>
  entries.filter((e): e is Extract<PlaygroundEntry, { type: "turn" }> => e.type === "turn");

describe("playground (spec §11)", () => {
  let sessionId: string;

  it("offers the templates and businesses to chat with", async () => {
    const options = await playgroundOptions(h.deps, owner);
    expect(options.unavailable).toBeNull();
    expect(options.templates).toEqual([
      expect.objectContaining({ slug: "odontologia", model: ODONTOLOGIA_MODEL }),
    ]);
    expect(options.businesses.map((b) => b.name).sort()).toEqual(["Clínica B", "Clínica Demo"]);
  });

  it("lists versions oldest to newest by semver, each with its model", async () => {
    // Uploaded out of order: the major first, then the minor.
    const major = laterVersion("major");
    const minor = laterVersion("minor");
    await uploadTemplate(h.deps, owner, odontologiaAt(major));
    await uploadTemplate(
      h.deps,
      owner,
      odontologiaAt(minor).replace(`model: ${ODONTOLOGIA_MODEL}`, "model: claude-sonnet-5-5"),
    );
    const options = await playgroundOptions(h.deps, owner);
    expect(options.templates.map((t) => [t.version, t.model])).toEqual([
      [ODONTOLOGIA_VERSION, ODONTOLOGIA_MODEL],
      [minor, "claude-sonnet-5-5"],
      [major, ODONTOLOGIA_MODEL],
    ]);
  });

  it("answers in a sandbox with the sample config, showing tool calls, tokens and cost", async () => {
    const version = (await playgroundOptions(h.deps, owner)).templates[0]?.version ?? "";
    ({ sessionId } = await startPlayground(h.deps, owner, {
      slug: "odontologia",
      version,
      businessId: null,
      consentGiven: true,
    }));
    const before = h.core.graph.requests.length;
    await playgroundSay(h.deps, owner, sessionId, "Hola, ¿cuánto vale una limpieza?");
    const detail = await playgroundDetail(h.deps, owner, sessionId);
    expect(detail).toMatchObject({
      status: "active",
      config: "Sample config",
      model: ODONTOLOGIA_MODEL,
      messages: 1,
      busy: false,
    });
    expect(detail.entries[0]).toMatchObject({
      type: "note",
      text: expect.stringContaining("Sillón 1"),
    });
    const [turn] = turns(detail.entries);
    expect(turn?.replies).toEqual([
      {
        body: "La limpieza dental tiene un valor de $120.000. ¿Desea agendar una cita?",
        kind: "agent",
      },
    ]);
    expect(turn?.usage.input).toBeGreaterThan(0);
    expect(turn?.costUsd).toBeGreaterThan(0);
    expect(detail.costUsd).toBeCloseTo(turn?.costUsd ?? 0, 6);
    // Nothing went to WhatsApp (the fake Graph API saw no request).
    expect(h.core.graph.requests.length).toBe(before);
  });

  it("hands off, stays silent while the handoff is open, and goes back to the bot", async () => {
    await playgroundSay(h.deps, owner, sessionId, "Me duele muchísimo y tengo la cara hinchada");
    let detail = await playgroundDetail(h.deps, owner, sessionId);
    expect(detail.state).toMatchObject({
      mode: "human",
      handoffs: [{ reason: "urgencia", open: true }],
    });
    expect(turns(detail.entries).at(-1)?.logs).toContainEqual(
      expect.objectContaining({ alert: "handoff_emergency" }),
    );

    await playgroundSay(h.deps, owner, sessionId, "¿Hola?");
    detail = await playgroundDetail(h.deps, owner, sessionId);
    expect(turns(detail.entries).at(-1)?.replies).toEqual([]);

    await playgroundReturnToBot(h.deps, owner, sessionId);
    detail = await playgroundDetail(h.deps, owner, sessionId);
    expect(detail.entries.at(-1)).toMatchObject({ type: "note", state: { mode: "bot" } });
  });

  it("answers one message at a time", async () => {
    const now = new Date();
    expect(
      await claimPlaygroundTurn(h.deps.db, sessionId, now, new Date(now.getTime() - 60_000)),
    ).toBe(true);
    await expect(playgroundSay(h.deps, owner, sessionId, "hola")).rejects.toMatchObject({
      code: "busy",
    });
    // A claim left by a request that died is taken over.
    h.setClock(new Date(Date.now() + 10 * 60_000));
    await playgroundSay(h.deps, owner, sessionId, "Hola, ¿cuánto vale una limpieza?");
    h.setClock(new Date());
  });

  it("can use a real business's config, resources and closures", async () => {
    await createResource(h.deps.db, { businessId: h.b.id, kind: "chair", name: "Sillón Azul" });
    const { sessionId: id } = await startPlayground(h.deps, owner, {
      slug: h.b.templateSlug,
      version: h.b.templateVersion,
      businessId: h.b.id,
      consentGiven: false,
    });
    const detail = await playgroundDetail(h.deps, owner, id);
    expect(detail).toMatchObject({ config: "Clínica B", consentGiven: false });
    expect(detail.entries[0]).toMatchObject({ text: expect.stringContaining("Sillón Azul") });
    await playgroundSay(h.deps, owner, id, "Hola, ¿cuánto vale una limpieza?");
    const [turn] = turns((await playgroundDetail(h.deps, owner, id)).entries);
    // A new contact gets the privacy notice first.
    expect(turn?.replies[0]?.kind).toBe("fixed");
    await closePlayground(h.deps, owner, id);
  });

  it("ends a session: its database is dropped and the transcript stays", async () => {
    const session = await getPlaygroundSession(h.deps.db, sessionId);
    await closePlayground(h.deps, owner, sessionId);
    expect(await listScratchDatabases(h.core.testDb.url, "play")).not.toContain(
      session?.databaseName,
    );
    const detail = await playgroundDetail(h.deps, owner, sessionId);
    expect(detail.status).toBe("closed");
    expect(detail.messages).toBeGreaterThan(0);
    await expect(playgroundSay(h.deps, owner, sessionId, "hola")).rejects.toMatchObject({
      code: "closed",
    });
    await deletePlayground(h.deps, owner, sessionId);
    expect(await getPlaygroundSession(h.deps.db, sessionId)).toBeNull();
  });

  it("says why it's off without an API key, and is for the owner only", async () => {
    const deps = { ...h.deps, playground: { databaseUrl: h.core.testDb.url, llm: null } };
    expect((await playgroundOptions(deps, owner)).unavailable).toMatch(/ANTHROPIC_API_KEY/);
    await expect(
      startPlayground(deps, owner, {
        slug: "odontologia",
        version: "1.0.0",
        businessId: null,
        consentGiven: true,
      }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    const admin = await h.actor("admin@playground.co", { business: h.a });
    await expect(playgroundOptions(h.deps, admin)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listPlaygrounds(h.deps, admin)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
