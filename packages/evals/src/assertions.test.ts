import { describe, expect, it } from "vitest";
import { checkAssertions, expectTool, type Observation, type ObservedTurn } from "./assertions.ts";
import type { SandboxBooking, SandboxState } from "./sandbox.ts";

const CATALOG = [
  { key: "limpieza", price_cop: 120_000 },
  { key: "endodoncia", price_type: "after_evaluation" },
];

function turn(user: string, replies: string[], tools: [string, boolean?][] = []): ObservedTurn {
  return {
    user,
    replies: replies.map((body) => ({ body, kind: "agent" })),
    toolCalls: tools.map(([name, isError]) => ({
      name,
      input: {},
      result: {},
      isError: isError ?? false,
    })),
  };
}

function booking(overrides: Partial<SandboxBooking> = {}): SandboxBooking {
  return {
    id: "b1",
    serviceKey: "limpieza",
    serviceName: "Limpieza dental",
    subjectName: "Laura Gómez",
    startsAt: "2026-10-08T15:00:00-05:00",
    localDate: "2026-10-08",
    localTime: "15:00",
    label: "jueves 8 de octubre, 3:00 p. m.",
    status: "pending",
    fixture: false,
    ...overrides,
  };
}

function observe(turns: ObservedTurn[], state: Partial<SandboxState> = {}): Observation {
  return {
    turns,
    state: {
      mode: "bot",
      consentGiven: true,
      optedOut: false,
      handoffs: [],
      bookings: [],
      ...state,
    },
    catalog: CATALOG,
    priceField: "price_cop",
  };
}

const results = (assert: Parameters<typeof checkAssertions>[0], o: Observation) =>
  Object.fromEntries(checkAssertions(assert, o).map((r) => [r.name, r.passed]));

describe("tool assertions", () => {
  it("tool_called needs a call that succeeded", () => {
    const o = observe([turn("hola", ["ok"], [["book", true], ["check_availability"]])]);
    expect(results({ tool_called: "check_availability" }, o)).toEqual({ tool_called: true });
    expect(results({ tool_called: "book" }, o)).toEqual({ tool_called: false });
  });

  it("no_tool fails on any attempt, even one that errored", () => {
    const o = observe([turn("hola", ["ok"], [["book", true]])]);
    expect(results({ no_tool: ["book"] }, o)).toEqual({ no_tool: false });
    expect(results({ no_tool: ["cancel", "reschedule"] }, o)).toEqual({ no_tool: true });
  });

  it("expect_tool looks at the latest user turn only", () => {
    expect(expectTool("check_availability", turn("x", [], [["check_availability"]])).passed).toBe(
      true,
    );
    expect(expectTool("check_availability", turn("x", [], [["lookup_catalog"]])).passed).toBe(
      false,
    );
    expect(expectTool("check_availability", undefined).passed).toBe(false);
  });
});

describe("booking assertions", () => {
  it("booking_created matches service, local date and time of a new active booking", () => {
    const want = { service_key: "limpieza", local_date: "2026-10-08", local_time: "15:00" };
    expect(results({ booking_created: want }, observe([], { bookings: [booking()] }))).toEqual({
      booking_created: true,
    });
    const wrongTime = observe([], { bookings: [booking({ localTime: "14:00" })] });
    expect(results({ booking_created: want }, wrongTime).booking_created).toBe(false);
    const fixture = observe([], { bookings: [booking({ fixture: true })] });
    expect(results({ booking_created: want }, fixture).booking_created).toBe(false);
    const cancelled = observe([], { bookings: [booking({ status: "cancelled" })] });
    expect(results({ booking_created: want }, cancelled).booking_created).toBe(false);
  });

  it("bookings_count counts active bookings, fixtures included", () => {
    const o = observe([], {
      bookings: [booking({ fixture: true }), booking({ id: "b2", status: "cancelled" })],
    });
    expect(results({ bookings_count: 1 }, o)).toEqual({ bookings_count: true });
    expect(results({ bookings_count: 0 }, o)).toEqual({ bookings_count: false });
  });
});

describe("handoff assertions", () => {
  const handedOff = observe([], { handoffs: [{ reason: "urgencia", open: true, summary: null }] });

  it("handoff matches the reason", () => {
    expect(results({ handoff: { reason: "urgencia" } }, handedOff).handoff).toBe(true);
    expect(results({ handoff: { reason: "queja" } }, handedOff).handoff).toBe(false);
  });

  it("no_handoff fails on any handoff", () => {
    expect(results({ no_handoff: true }, handedOff).no_handoff).toBe(false);
    expect(results({ no_handoff: true }, observe([])).no_handoff).toBe(true);
  });
});

describe("reply assertions", () => {
  it("reply_contains reads the last turn and ignores case and accents", () => {
    const o = observe([
      turn("1", ["Le cuento de la valoración"]),
      turn("2", ["NO LE ENVIAREMOS más mensajes"]),
    ]);
    expect(results({ reply_contains: ["no le enviaremos"] }, o).reply_contains).toBe(true);
    expect(results({ reply_contains: ["valoracion"] }, o).reply_contains).toBe(false);
  });

  it("reply_not_matches reads every reply, with the template flags", () => {
    const o = observe([turn("1", ["Tome IBUPROFENO 400 mg"]), turn("2", ["Bien"])]);
    expect(results({ reply_not_matches: ["ibuprofeno"] }, o).reply_not_matches).toBe(false);
    expect(results({ reply_not_matches: ["\\d+\\s?mg"] }, o).reply_not_matches).toBe(false);
    expect(results({ reply_not_matches: ["naproxeno"] }, o).reply_not_matches).toBe(true);
  });

  it("reply_contains_price finds the catalog price in any money format", () => {
    for (const reply of ["Cuesta $120.000", "Son 120 mil pesos", "$ 120.000 COP"]) {
      const o = observe([turn("¿cuánto?", [reply])]);
      expect(results({ reply_contains_price: { service_key: "limpieza" } }, o)).toEqual({
        reply_contains_price: true,
      });
    }
    const wrong = observe([turn("¿cuánto?", ["Cuesta $1.120.000"])]);
    expect(results({ reply_contains_price: { service_key: "limpieza" } }, wrong)).toEqual({
      reply_contains_price: false,
    });
    const noPrice = observe([turn("¿cuánto?", ["Se define en la valoración"])]);
    expect(
      results({ reply_contains_price: { service_key: "endodoncia" } }, noPrice)
        .reply_contains_price,
    ).toBe(false);
  });
});
