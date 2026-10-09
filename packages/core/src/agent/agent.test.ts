import { parseWebhook } from "@platform/channels";
import { webhookFixture } from "@platform/channels/testing";
import {
  bookingProposals,
  bookings,
  contacts,
  conversations,
  createResource,
  getContact,
  getConversation,
  handoffs,
  listStaffNotifications,
  listUnprocessedInbound,
  messages,
  recordUsage,
  updateBusinessHolidays,
  withTenant,
} from "@platform/db";
import type { LlmClient } from "@platform/llm";
import { scriptedLlm, transientLlmError, type ScriptStep } from "@platform/llm/testing";
import { builtinProvider } from "@platform/scheduling";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChannelResolver, ingestWebhookEvents } from "../inbound/ingest.ts";
import { processInboundBatch } from "../inbound/process.ts";
import { createCoreHarness, type CoreHarness } from "../testing.ts";
import { createAgentResponder } from "./responder.ts";
import { dynamicBlock, loadTurn } from "./turn.ts";
import { AGENT_TOOLS } from "./tools/registry.ts";
import type { BookingEvent } from "./tools/types.ts";

/** Spec §11: evals run on this clock, a Monday. */
const NOW = new Date("2026-10-05T09:00:00-05:00");
const MODEL = "claude-haiku-4-5-20251001";

let h: CoreHarness;
let events: BookingEvent[];
let counter = 0;

beforeAll(async () => {
  h = await createCoreHarness();
  events = [];
  await createResource(h.testDb.db, { businessId: h.business.id, kind: "chair", name: "Sillón 1" });
});

afterAll(async () => {
  await h.close();
});

/** Ingests a text from `from` (Meta's recorded webhook with our values). */
async function receive(from: string, text: string) {
  counter += 1;
  const json = JSON.stringify(webhookFixture("text-message"))
    .replaceAll("16505551234", from)
    .replace("Does it come in another color?", text)
    .replace(/"id":"wamid\.[^"]+"/, `"id":"wamid.agent-${String(counter)}"`)
    .replace(
      /"timestamp":"\d+"/,
      `"timestamp":"${String(Math.floor(NOW.getTime() / 1000) + counter)}"`,
    );
  const parsed = parseWebhook(JSON.parse(json));
  if (!parsed.ok) throw new Error(parsed.error);
  const jobs: { businessId: string; conversationId: string }[] = [];
  await ingestWebhookEvents(
    {
      db: h.deps.db,
      logger: h.deps.logger,
      resolveChannel: createChannelResolver(h.deps.db),
      enqueue: (d) =>
        Promise.resolve(
          void jobs.push({ businessId: d.businessId, conversationId: d.conversationId }),
        ),
    },
    parsed.events,
  );
  const job = jobs[0];
  if (!job) throw new Error("not enqueued");
  return job;
}

async function giveConsent(from: string) {
  await h.testDb.db
    .update(contacts)
    .set({ consentAt: NOW, consentRequestedAt: NOW })
    .where(eq(contacts.waNumber, from));
}

function responderWith(llm: LlmClient) {
  return createAgentResponder({
    db: h.deps.db,
    logger: h.deps.logger,
    now: () => NOW,
    provider: builtinProvider,
    events: { emit: (e) => Promise.resolve(void events.push(e)) },
    llm,
    llmBudgetUsdMonth: 20,
  });
}

/** The turn the agent would build for a job, for calling tools directly. */
async function turnFor(job: { businessId: string; conversationId: string }) {
  const batch = await withTenant(h.deps.db, job.businessId, async (tx) => {
    const conversation = await getConversation(tx, job.conversationId);
    const contact = conversation ? await getContact(tx, conversation.contactId) : null;
    if (!conversation || !contact) throw new Error("missing");
    return {
      businessId: job.businessId,
      conversation,
      contact,
      messages: await listUnprocessedInbound(tx, job.conversationId),
    };
  });
  const turn = await loadTurn(
    {
      db: h.deps.db,
      logger: h.deps.logger,
      now: () => NOW,
      provider: builtinProvider,
      events: { emit: () => Promise.resolve() },
    },
    batch,
  );
  if (!turn) throw new Error("no turn");
  return turn;
}

const sentTo = (from: string, before: number) =>
  h.graph.requests
    .slice(before)
    .filter((r) => r.body.to === from)
    .map((r) => (r.body.text as { body: string }).body);

/** One customer turn through the real pipeline; returns what was sent to WhatsApp. */
async function say(
  from: string,
  text: string,
  steps: ScriptStep[],
  options: { consent?: boolean; finalAttempt?: boolean } = {},
) {
  const job = await receive(from, text);
  if (options.consent !== false) await giveConsent(from);
  const llm = scriptedLlm(steps);
  const before = h.graph.requests.length;
  await processInboundBatch({ ...h.deps, now: () => NOW, responder: responderWith(llm) }, job, {
    finalAttempt: options.finalAttempt ?? true,
  });
  return { sent: sentTo(from, before), llm, job };
}

const toolResult = (llm: ReturnType<typeof scriptedLlm>, call: number) => {
  const last = llm.requests[call]?.messages.at(-1);
  const block = Array.isArray(last?.content) ? last.content[0] : undefined;
  return block && block.type === "tool_result" && typeof block.content === "string"
    ? (JSON.parse(block.content) as Record<string, unknown>)
    : null;
};

describe("answers from the business's facts", () => {
  it("price question: looks up the catalog and replies (eval precio_limpieza)", async () => {
    const { sent, llm } = await say("573200000001", "Hola, ¿cuánto vale una limpieza?", [
      { tools: [{ name: "lookup_catalog", input: { query: "limpieza" } }] },
      { text: "La limpieza dental cuesta $120.000 y dura 45 minutos. ¿Le agendo una cita?" },
    ]);
    expect(sent).toEqual([
      "La limpieza dental cuesta $120.000 y dura 45 minutos. ¿Le agendo una cita?",
    ]);
    expect(toolResult(llm, 1)).toMatchObject({
      items: [{ key: "limpieza", price_type: "fixed", price_cop: 120000, duration_min: 45 }],
    });

    const request = llm.requests[0];
    expect(request?.model).toBe(MODEL);
    expect(request?.system).toMatchObject([
      {
        type: "text",
        cache_control: { type: "ephemeral" },
        text: expect.stringContaining("DATOS DEL CONSULTORIO"),
      },
      {
        type: "text",
        text: expect.stringContaining(
          "Fecha y hora actual: lunes 5 de octubre de 2026, 9:00 a. m.",
        ),
      },
    ]);
    expect(request?.tools?.map((t) => (t as { name: string }).name)).toEqual([
      "lookup_catalog",
      "check_availability",
      "book",
      "find_bookings",
      "reschedule",
      "cancel",
      "handoff",
    ]);
  });

  it("records tokens and cost on the reply and in usage_events", async () => {
    const rows = await h.testDb.pool.query<{
      input_tokens: number;
      cost_usd: string;
      kind: string;
    }>(
      "SELECT input_tokens, cost_usd, payload->>'kind' AS kind FROM messages WHERE direction = 'outbound' AND input_tokens IS NOT NULL",
    );
    // Two calls of 1000 input + 50 output tokens on Haiku 4.5: 2×(1000×$1 + 50×$5)/1M.
    expect(rows.rows[0]).toEqual({ input_tokens: 2000, cost_usd: "0.002500", kind: "agent" });
    const usage = await h.testDb.pool.query("SELECT kind, units FROM usage_events");
    expect(usage.rows).toContainEqual({ kind: "llm", units: 2100 });
  });

  it("price guard: rewrites a reply with an invented price", async () => {
    const { sent, llm } = await say("573200000002", "¿Cuánto vale la limpieza?", [
      { text: "La limpieza vale $100.000." },
      { text: "La limpieza dental cuesta $120.000." },
    ]);
    expect(sent).toEqual(["La limpieza dental cuesta $120.000."]);
    expect(llm.requests[1]?.tool_choice).toEqual({ type: "none" });
    expect(JSON.stringify(llm.requests[1]?.system)).toContain("not catalog prices (100000)");
  });

  it("price guard: hands off when the rewrite still invents a price", async () => {
    const { sent } = await say("573200000003", "¿Cuánto vale la endodoncia?", [
      { text: "La endodoncia vale $900.000." },
      { text: "Unos 900 mil." },
    ]);
    expect(sent).toEqual([
      "Prefiero confirmar ese dato con el equipo para no darle información equivocada. Ya les aviso y le escriben pronto.",
    ]);
    const [handoff] = await h.testDb.db
      .select()
      .from(handoffs)
      .where(eq(handoffs.reason, "price_guard"));
    expect(handoff).toBeDefined();
  });

  it("price guard: a failed rewrite hands off instead of failing the job", async () => {
    const { sent, job } = await say(
      "573200000004",
      "¿Cuánto vale la ortodoncia?",
      [
        { text: "La ortodoncia vale $3.000.000." },
        () => {
          throw transientLlmError();
        },
      ],
      { finalAttempt: false },
    );
    expect(sent).toEqual([
      "Prefiero confirmar ese dato con el equipo para no darle información equivocada. Ya les aviso y le escriben pronto.",
    ]);
    const mine = await h.testDb.db
      .select()
      .from(handoffs)
      .where(eq(handoffs.conversationId, job.conversationId));
    expect(mine.map((r) => r.reason)).toEqual(["price_guard"]);
  });
});

describe("booking with server-enforced confirmation (decision A5)", () => {
  const availability = {
    name: "check_availability",
    input: {
      service_key: "limpieza",
      date_from: "2026-10-08",
      date_to: "2026-10-08",
      time_of_day: "afternoon",
      around_time: "15:00",
    },
  };
  const bookInput = {
    service_key: "limpieza",
    starts_at: "2026-10-08T15:00:00-05:00",
    subject_name: "Laura Gómez",
    for_self: true,
    confirmed_by_customer: false,
  };

  it("checks availability, proposes, and books only after a later 'sí' (eval agenda_simple)", async () => {
    const from = "573200000010";
    const first = await say(
      from,
      "Quiero una limpieza el jueves a las 3 de la tarde. Me llamo Laura Gómez",
      [
        { tools: [availability] },
        { tools: [{ name: "book", input: bookInput }] },
        {
          text: "Le confirmo: limpieza dental el jueves 8 de octubre a las 3:00 p. m., $120.000, a nombre de Laura Gómez. ¿La agendo?",
        },
      ],
    );
    expect(toolResult(first.llm, 1)).toMatchObject({
      exact: {
        time: "15:00",
        available: true,
        starts_at: "2026-10-08T15:00:00-05:00",
        label: "jueves 8 de octubre, 3:00 p. m.",
      },
    });
    const proposal = toolResult(first.llm, 2);
    expect(proposal).toMatchObject({
      status: "needs_confirmation",
      summary: { price_cop: 120000, label: "jueves 8 de octubre, 3:00 p. m." },
    });
    expect(await h.testDb.db.select().from(bookings)).toEqual([]);

    const second = await say(from, "Sí, confirmo", [
      {
        tools: [
          {
            name: "book",
            input: {
              ...bookInput,
              confirmed_by_customer: true,
              proposal_id: proposal?.proposal_id,
            },
          },
        ],
      },
      { text: "¡Listo! Su cita quedó agendada para el jueves 8 de octubre a las 3:00 p. m." },
    ]);
    expect(JSON.stringify(second.llm.requests[0]?.system)).toContain(
      `proposal_id ${String(proposal?.proposal_id)}`,
    );
    expect(toolResult(second.llm, 1)).toMatchObject({
      status: "booked",
      booking: { label: "jueves 8 de octubre, 3:00 p. m." },
    });
    const [booking] = await h.testDb.db.select().from(bookings);
    expect(booking).toMatchObject({
      serviceKey: "limpieza",
      subjectName: "Laura Gómez",
      status: "pending",
      source: "agent",
      priceCop: 120000,
    });
    expect(booking?.startsAt).toEqual(new Date("2026-10-08T15:00:00-05:00"));
    expect(events.map((e) => e.type)).toContain("booking.created");
    // Decision A10: the name typed for themselves becomes the contact's name.
    const [contact] = await h.testDb.db.select().from(contacts).where(eq(contacts.waNumber, from));
    expect(contact?.name).toBe("Laura Gómez");
  });

  it("never books in the same message the customer asked (eval no_agenda_sin_confirmar)", async () => {
    const from = "573200000011";
    const { llm } = await say(from, "Quiero una valoración mañana a las 10, soy Pedro Ruiz", [
      {
        tools: [
          {
            name: "book",
            input: {
              service_key: "valoracion",
              starts_at: "2026-10-06T10:00:00-05:00",
              subject_name: "Pedro Ruiz",
              for_self: true,
              confirmed_by_customer: true,
            },
          },
        ],
      },
      {
        text: "¿Le confirmo la valoración mañana martes 6 de octubre a las 10:00 a. m. por $50.000?",
      },
    ]);
    expect(toolResult(llm, 1)).toMatchObject({
      status: "needs_confirmation",
      note: expect.stringContaining("hasn't confirmed"),
    });
    const rows = await h.testDb.db
      .select()
      .from(bookings)
      .where(eq(bookings.subjectName, "Pedro Ruiz"));
    expect(rows).toEqual([]);
  });

  it("reschedules and cancels with the same two steps", async () => {
    const from = "573200000010";
    const [booking] = await h.testDb.db
      .select()
      .from(bookings)
      .where(eq(bookings.subjectName, "Laura Gómez"));
    const move = {
      name: "reschedule",
      input: {
        booking_id: booking?.id,
        new_starts_at: "2026-10-09T09:00:00-05:00",
        confirmed_by_customer: false,
      },
    };
    await say(from, "¿La podemos pasar para el viernes a las 9?", [
      { tools: [move] },
      { text: "¿Le cambio la cita al viernes 9 de octubre a las 9:00 a. m.?" },
    ]);
    const moved = await say(from, "Sí", [
      { tools: [{ ...move, input: { ...move.input, confirmed_by_customer: true } }] },
      { text: "Listo, quedó para el viernes 9 a las 9:00 a. m." },
    ]);
    expect(toolResult(moved.llm, 1)).toMatchObject({
      status: "rescheduled",
      booking: { label: "viernes 9 de octubre, 9:00 a. m." },
    });

    const cancel = {
      name: "cancel",
      input: { booking_id: booking?.id, confirmed_by_customer: false },
    };
    await say(from, "Mejor cancélela", [
      { tools: [cancel] },
      { text: "¿Confirma que cancelo la cita del viernes?" },
    ]);
    await say(from, "Sí, cancélela", [
      { tools: [{ ...cancel, input: { ...cancel.input, confirmed_by_customer: true } }] },
      { text: "Cita cancelada." },
    ]);
    const [after] = await h.testDb.db
      .select()
      .from(bookings)
      .where(eq(bookings.id, booking?.id ?? ""));
    expect(after?.status).toBe("cancelled");
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["booking.rescheduled", "booking.cancelled"]),
    );
  });

  it("can't touch another contact's booking", async () => {
    const [laura] = await h.testDb.db
      .select()
      .from(bookings)
      .where(eq(bookings.subjectName, "Laura Gómez"));
    const { llm } = await say("573200000012", "Cancele la cita", [
      {
        tools: [{ name: "cancel", input: { booking_id: laura?.id, confirmed_by_customer: true } }],
      },
      { text: "No encuentro esa cita." },
    ]);
    expect(toolResult(llm, 1)).toMatchObject({ error: "booking_not_found" });
  });

  it("returns invalid tool input to the model instead of running it", async () => {
    const { llm } = await say("573200000013", "Hola", [
      {
        tools: [
          { name: "check_availability", input: { service_key: "limpieza", date_from: "jueves" } },
        ],
      },
      { text: "¿Para qué fecha?" },
    ]);
    const last = llm.requests[1]?.messages.at(-1);
    expect(Array.isArray(last?.content) && last.content[0]).toMatchObject({
      type: "tool_result",
      is_error: true,
    });
    expect(toolResult(llm, 1)).toMatchObject({ error: "invalid_input" });
  });

  it("20 parallel book calls on one slot → exactly 1 booking (spec M3)", async () => {
    const { job } = await say("573200000014", "Hola", [{ text: "¡Hola!" }]);
    const turn = await turnFor(job);
    const input = {
      service_key: "limpieza",
      starts_at: "2026-10-14T10:00:00-05:00",
      subject_name: "Ana Pérez",
      for_self: true,
      confirmed_by_customer: true,
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        AGENT_TOOLS.book.run(turn.tool, input, { require_explicit_confirmation: false }),
      ),
    );
    expect(results.filter((r) => r.result.status === "booked")).toHaveLength(1);
    expect(
      results
        .filter((r) => r.result.status !== "booked")
        .every((r) => ["slot_taken", "unavailable"].includes(String(r.result.status))),
    ).toBe(true);
    const rows = await h.testDb.db
      .select()
      .from(bookings)
      .where(eq(bookings.subjectName, "Ana Pérez"));
    expect(rows).toHaveLength(1);
  });
});

describe("public holidays (spec review C2)", () => {
  const holiday = {
    service_key: "limpieza",
    date_from: "2026-10-12",
    date_to: "2026-10-12",
  };

  it("are closed by default: no slots, and the calendar says so", async () => {
    const job = await receive("573200000060", "¿Tienen cita el lunes festivo?");
    await giveConsent("573200000060");
    const turn = await turnFor(job);
    const { result } = await AGENT_TOOLS.check_availability.run(turn.tool, holiday, {});
    expect(result).toMatchObject({
      slots: [],
      closed_holidays: [{ date: "2026-10-12", name: "Día de la Diversidad Étnica y Cultural" }],
    });
    const booked = await AGENT_TOOLS.book.run(
      turn.tool,
      {
        service_key: "limpieza",
        starts_at: "2026-10-12T10:00:00-05:00",
        subject_name: "Ana Pérez",
        for_self: true,
        confirmed_by_customer: true,
      },
      { require_explicit_confirmation: false },
    );
    expect(booked.result.status).toBe("unavailable");
    expect(await dynamicBlock(turn, [])).toContain(
      "- lunes 12 de octubre: 2026-10-12 (festivo: Día de la Diversidad Étnica y Cultural, cerrado)",
    );
  });

  it("open with the weekday's hours when the business chose to open", async () => {
    await updateBusinessHolidays(h.testDb.db, h.business.id, {
      open_holidays: ["diversidad_etnica_y_cultural"],
    });
    try {
      const job = await receive("573200000061", "¿Tienen cita el lunes festivo?");
      await giveConsent("573200000061");
      const turn = await turnFor(job);
      const { result } = await AGENT_TOOLS.check_availability.run(turn.tool, holiday, {});
      expect((result.slots as unknown[]).length).toBeGreaterThan(0);
      expect(result.closed_holidays).toBeUndefined();
      expect(await dynamicBlock(turn, [])).toContain(
        "2026-10-12 (festivo: Día de la Diversidad Étnica y Cultural, abierto)",
      );
    } finally {
      await updateBusinessHolidays(h.testDb.db, h.business.id, {});
    }
  });
});

describe("confirmation can't be carried over (decision A5)", () => {
  const tuesday = (time: string) => `2026-10-13T${time}:00-05:00`;
  const book = (name: string, startsAt: string, extra: Record<string, unknown> = {}) => ({
    name: "book",
    input: {
      service_key: "limpieza",
      starts_at: startsAt,
      subject_name: name,
      for_self: true,
      confirmed_by_customer: false,
      ...extra,
    },
  });
  const bookingsOf = (name: string) =>
    h.testDb.db.select().from(bookings).where(eq(bookings.subjectName, name));

  it("a proposal_id doesn't confirm a different time", async () => {
    const from = "573200000015";
    const first = await say(from, "Una limpieza el martes a las 11, soy Sofía Mora", [
      { tools: [book("Sofía Mora", tuesday("11:00"))] },
      { text: "¿Le agendo la limpieza el martes 13 a las 11:00 a. m.?" },
    ]);
    const proposal = toolResult(first.llm, 1);
    expect(proposal).toMatchObject({ status: "needs_confirmation" });

    const second = await say(from, "Sí", [
      {
        tools: [
          book("Sofía Mora", tuesday("14:00"), {
            confirmed_by_customer: true,
            proposal_id: proposal?.proposal_id,
          }),
        ],
      },
      { text: "¿Le confirmo el martes a las 2:00 p. m.?" },
    ]);
    expect(toolResult(second.llm, 1)).toMatchObject({
      status: "needs_confirmation",
      note: expect.stringContaining("hasn't confirmed"),
    });
    expect(await bookingsOf("Sofía Mora")).toEqual([]);
  });

  it("a proposal from a failed attempt was never shown, so it isn't confirmed by the retry", async () => {
    const from = "573200000016";
    const job = await receive(from, "Una limpieza el martes a las 9, soy Tomás Gil");
    await giveConsent(from);
    const proposeThenFail = scriptedLlm([
      { tools: [book("Tomás Gil", tuesday("09:00"))] },
      () => {
        throw transientLlmError();
      },
    ]);
    await expect(
      processInboundBatch(
        { ...h.deps, now: () => NOW, responder: responderWith(proposeThenFail) },
        job,
        { finalAttempt: false },
      ),
    ).rejects.toThrow(/Connection error/);
    // The tokens of the call that did succeed still count toward the budget (principle 10).
    const spent = await h.testDb.pool.query(
      "SELECT units FROM usage_events WHERE details->>'conversation_id' = $1",
      [job.conversationId],
    );
    expect(spent.rows).toEqual([{ units: 1050 }]);

    // The customer writes again before the retry, which then handles both messages.
    await receive(from, "Sí, para esa hora");
    const retry = scriptedLlm([
      { tools: [book("Tomás Gil", tuesday("09:00"), { confirmed_by_customer: true })] },
      { text: "¿Le confirmo la limpieza el martes 13 a las 9:00 a. m.?" },
    ]);
    await processInboundBatch({ ...h.deps, now: () => NOW, responder: responderWith(retry) }, job);
    expect(toolResult(retry, 1)).toMatchObject({ status: "needs_confirmation" });
    expect(await bookingsOf("Tomás Gil")).toEqual([]);
  });
});

describe("guardrails before the model", () => {
  it("emergency: fixed reply with the urgent phone, handoff, no model call (eval urgencia)", async () => {
    const { sent, llm } = await say(
      "573200000020",
      "Me duele muchísimo una muela y tengo la cara hinchada",
      [],
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("3000000000");
    expect(llm.requests).toEqual([]);
    const [conversation] = await h.testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, await receiveConversation("573200000020")));
    expect(conversation?.mode).toBe("human");
  });

  it("emergency on first contact: no consent form first (eval urgencia_primer_contacto)", async () => {
    const { sent } = await say(
      "573200000021",
      "Hola, me golpearon y se me partió un diente, tengo la cara hinchada",
      [],
      { consent: false },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("3000000000");
    expect(sent.join()).not.toMatch(/Responda S[ÍI] para continuar/);
  });

  it("emergency during a handoff: replies once, then stays silent (decision A3)", async () => {
    const from = "573200000020";
    const second = await say(from, "sigue la cara hinchada", []);
    expect(second.sent).toEqual([]);
    const ordinary = await say(from, "¿Me pueden llamar?", []);
    expect(ordinary.sent).toEqual([]); // principle 7: a person is handling it
  });

  it("opt-out: 'PARA' confirms and records it (eval opt_out)", async () => {
    const { sent, llm } = await say("573200000022", "PARA", []);
    expect(sent).toEqual([
      "Listo, no le enviaremos más mensajes automáticos. Si necesita algo, escríbanos cuando quiera.",
    ]);
    expect(llm.requests).toEqual([]);
    const [contact] = await h.testDb.db
      .select()
      .from(contacts)
      .where(eq(contacts.waNumber, "573200000022"));
    expect(contact?.optedOutAt).toEqual(NOW);
  });

  it("over the monthly LLM budget: hands off without calling the model (principle 10)", async () => {
    await recordUsage(h.testDb.db, {
      businessId: h.business.id,
      kind: "llm",
      units: 1,
      costUsd: 25,
    });
    const { sent, llm } = await say("573200000023", "Hola", []);
    expect(llm.requests).toEqual([]);
    expect(sent).toEqual([
      "Ya le paso su mensaje a una persona del equipo. Le respondemos en horario de atención lo antes posible.",
    ]);
    await h.testDb.pool.query("DELETE FROM usage_events WHERE cost_usd = 25");
  });

  it("at 90% of the monthly AI cap, the business gets one notification (C3)", async () => {
    await recordUsage(h.testDb.db, {
      businessId: h.business.id,
      kind: "llm",
      units: 1,
      costUsd: 18.5,
    });
    await say("573200000024", "Hola", [{ text: "Hola, ¿en qué le ayudo?" }]);
    await say("573200000024", "¿Atienden el sábado?", [{ text: "Sí, de 8:00 a. m. a 1:00 p. m." }]);
    const usage = (
      await withTenant(h.testDb.db, h.business.id, (tx) =>
        listStaffNotifications(tx, h.business.id),
      )
    ).filter((n) => n.kind === "usage");
    expect(usage.map((n) => n.payload.percent)).toEqual([90]);
    expect(usage[0]?.text).toMatch(
      /^Ya se usó el 90 % del límite mensual de inteligencia artificial \(18,5\d de 20,00 USD\)/,
    );
    expect(h.logs.filter((l) => l.alert === "usage_llm_90")).toHaveLength(1);
    await h.testDb.pool.query("DELETE FROM usage_events WHERE cost_usd = 18.5");
  });
});

describe("consent (decision A9)", () => {
  it("first contact: consent message, then FAQ-only help without booking tools", async () => {
    const from = "573200000030";
    const first = await say(
      from,
      "Hola, quiero agendar una limpieza",
      [{ text: "Con gusto. Primero responda SÍ al mensaje anterior." }],
      { consent: false },
    );
    expect(first.sent[0]).toContain("Responda SÍ para continuar");
    expect(first.sent[1]).toBe("Con gusto. Primero responda SÍ al mensaje anterior.");
    expect(first.llm.requests[0]?.tools?.map((t) => (t as { name: string }).name)).not.toContain(
      "book",
    );
    expect(JSON.stringify(first.llm.requests[0]?.system)).toContain(
      "has not accepted the data-processing consent",
    );

    const second = await say(
      from,
      "Sí",
      [{ text: "¡Gracias! ¿Qué día le queda bien para la limpieza?" }],
      { consent: false },
    );
    expect(second.sent).toEqual(["¡Gracias! ¿Qué día le queda bien para la limpieza?"]);
    expect(second.llm.requests[0]?.tools?.map((t) => (t as { name: string }).name)).toContain(
      "book",
    );
    // The model sees the first message, so the customer doesn't repeat it (eval consentimiento).
    expect(JSON.stringify(second.llm.requests[0]?.messages)).toContain(
      "quiero agendar una limpieza",
    );
    const [contact] = await h.testDb.db.select().from(contacts).where(eq(contacts.waNumber, from));
    expect(contact).toMatchObject({ consentAt: NOW, consentSource: "whatsapp" });
  });
});

describe("handoffs and failures", () => {
  it("model handoff: its words, then the template's handoff reply (eval servicio_no_listado)", async () => {
    const { sent } = await say("573200000040", "¿Ustedes hacen implantes?", [
      {
        tools: [
          { name: "handoff", input: { reason: "desconocido", summary: "Pregunta por implantes" } },
        ],
        text: "No tengo esa información.",
      },
    ]);
    expect(sent).toEqual([
      "No tengo esa información.",
      "Ya le paso su mensaje a una persona del equipo. Le respondemos en horario de atención lo antes posible.",
    ]);
    const rows = await h.testDb.db
      .select()
      .from(handoffs)
      .where(and(eq(handoffs.reason, "desconocido")));
    expect(rows).toHaveLength(1);
  });

  it("can't pick a platform-only handoff reason", async () => {
    const { llm } = await say("573200000041", "Hola", [
      { tools: [{ name: "handoff", input: { reason: "budget", summary: "x" } }] },
      { text: "¿En qué le ayudo?" },
    ]);
    expect(toolResult(llm, 1)).toMatchObject({ error: "invalid_input" });
  });

  it("hands off after too many tool calls in one turn", async () => {
    const lookup = { name: "lookup_catalog", input: {} };
    const { sent } = await say(
      "573200000042",
      "Hola",
      Array.from({ length: 7 }, () => ({ tools: [lookup] })),
    );
    expect(sent).toEqual([
      "Ya le paso su mensaje a una persona del equipo. Le respondemos en horario de atención lo antes posible.",
    ]);
  });

  it("an AI outage is retried by the job, and handed off on the last attempt", async () => {
    const from = "573200000043";
    const job = await receive(from, "Hola");
    await giveConsent(from);
    const deps = {
      db: h.deps.db,
      logger: h.deps.logger,
      now: () => NOW,
      provider: builtinProvider,
      events: { emit: () => Promise.resolve() },
      llmBudgetUsdMonth: 20,
    };
    const outage = () => {
      throw transientLlmError();
    };
    const early = createAgentResponder({ ...deps, llm: scriptedLlm([outage]) });
    await expect(
      processInboundBatch({ ...h.deps, now: () => NOW, responder: early }, job, {
        finalAttempt: false,
      }),
    ).rejects.toThrow(/Connection error/);
    const mine = () =>
      h.testDb.db
        .select()
        .from(handoffs)
        .where(and(eq(handoffs.reason, "error"), eq(handoffs.conversationId, job.conversationId)));
    expect(await mine()).toEqual([]);

    const last = createAgentResponder({ ...deps, llm: scriptedLlm([outage]) });
    const before = h.graph.requests.length;
    await processInboundBatch({ ...h.deps, now: () => NOW, responder: last }, job, {
      finalAttempt: true,
    });
    expect(await mine()).toHaveLength(1);
    expect(
      h.graph.requests.slice(before).map((r) => (r.body.text as { body: string }).body),
    ).toEqual([
      "Ya le paso su mensaje a una persona del equipo. Le respondemos en horario de atención lo antes posible.",
    ]);
  });
});

describe("contact fields", () => {
  it("two updates in one turn both stick", async () => {
    const { job } = await say("573200000050", "Es para mi hijo", [{ text: "¿Cómo se llama?" }]);
    const turn = await turnFor(job);
    const update = AGENT_TOOLS.update_contact;
    await update.run(turn.tool, { field: "is_minor", value: true }, {});
    await update.run(turn.tool, { field: "guardian_name", value: "Marta Ruiz" }, {});
    const [contact] = await h.testDb.db
      .select()
      .from(contacts)
      .where(eq(contacts.waNumber, "573200000050"));
    expect(contact?.fields).toEqual({ is_minor: true, guardian_name: "Marta Ruiz" });
  });
});

describe("history and proposals", () => {
  it("keeps proposals out of reach once consumed", async () => {
    const consumed = await h.testDb.db.select().from(bookingProposals);
    expect(consumed.filter((p) => p.consumedAt !== null).length).toBeGreaterThan(0);
  });

  it("stores model and template replies with their kind", async () => {
    const kinds = await h.testDb.pool.query<{ kind: string }>(
      "SELECT DISTINCT payload->>'kind' AS kind FROM messages WHERE direction = 'outbound' ORDER BY 1",
    );
    expect(kinds.rows.map((r) => r.kind)).toEqual(["agent", "fixed"]);
    const silent = await h.testDb.db.select().from(messages).where(eq(messages.status, "failed"));
    expect(silent).toEqual([]);
  });
});

async function receiveConversation(from: string): Promise<string> {
  const [contact] = await h.testDb.db.select().from(contacts).where(eq(contacts.waNumber, from));
  const [conversation] = await h.testDb.db
    .select()
    .from(conversations)
    .where(eq(conversations.contactId, contact?.id ?? ""));
  return conversation?.id ?? "";
}
