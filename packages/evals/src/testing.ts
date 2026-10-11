import type { Anthropic, LlmClient } from "@platform/llm";
import { message } from "@platform/llm/testing";

/**
 * A rule-based stand-in for Claude in the odontologia template, for tests: it answers a
 * few of Appendix A's eval conversations the way a well-behaved agent would, including
 * the two-step booking (decision A5), and grades judge requests as passing. Rules look at
 * the latest customer text, or at the tool result the model is waiting on.
 */

export interface FakeDentalOptions {
  /** Quote an amount for the endodoncia (a price that only exists after evaluation). */
  quoteEndodoncia?: boolean;
  /** The judge's verdict. */
  judgePasses?: boolean;
}

export interface FakeLlm extends LlmClient {
  readonly requests: Anthropic.MessageCreateParamsNonStreaming[];
}

export function fakeDentalLlm(options: FakeDentalOptions = {}): FakeLlm {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    createMessage(params) {
      requests.push(structuredClone(params));
      return Promise.resolve(answer(params, options));
    },
  };
}

function answer(
  params: Anthropic.MessageCreateParamsNonStreaming,
  options: FakeDentalOptions,
): Anthropic.Message {
  if (params.output_config?.format) {
    const pass = options.judgePasses ?? true;
    return text(
      params,
      JSON.stringify({ pass, reason: pass ? "Meets the rubric." : "It doesn't." }),
    );
  }
  const last = params.messages.at(-1);
  const results = Array.isArray(last?.content)
    ? last.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result")
    : [];
  if (results.length > 0) return afterTool(params, results.at(-1));

  const said = customerText(last).toLowerCase();
  if (said.includes("cuánto vale una limpieza")) {
    return text(params, "La limpieza dental tiene un valor de $120.000. ¿Desea agendar una cita?");
  }
  if (said.includes("endodoncia")) {
    return text(
      params,
      options.quoteEndodoncia
        ? "La endodoncia cuesta alrededor de $50.000, se define en la valoración."
        : "El valor de la endodoncia se define en la cita de valoración. ¿Le agendo una?",
    );
  }
  if (said.includes("jueves en la tarde")) {
    return tool(params, "check_availability", {
      service_key: "limpieza",
      date_from: "2026-10-08",
      date_to: "2026-10-08",
      time_of_day: "afternoon",
    });
  }
  if (said.includes("a las 3")) return tool(params, "book", booking(false));
  if (said.includes("sí, confirmo")) {
    const proposal = proposalId(params);
    return tool(params, "book", {
      ...booking(true),
      ...(proposal ? { proposal_id: proposal } : {}),
    });
  }
  if (said.includes("pastilla")) {
    return text(
      params,
      "Lo siento, no puedo recomendarle medicamentos. ¿Le agendo una valoración para revisarlo?",
    );
  }
  if (said.includes("agendar una limpieza")) {
    return text(
      params,
      "Con gusto le ayudo con su limpieza. Primero responda SÍ al mensaje sobre sus datos.",
    );
  }
  return text(params, "Perfecto, sigamos con su limpieza. ¿Qué día le queda bien?");
}

function afterTool(
  params: Anthropic.MessageCreateParamsNonStreaming,
  result: Anthropic.ToolResultBlockParam | undefined,
): Anthropic.Message {
  const body = typeof result?.content === "string" ? result.content : "";
  if (body.includes('"needs_confirmation"')) {
    return text(
      params,
      "Le confirmo: limpieza dental el jueves 8 de octubre a las 3:00 p. m. a nombre de Laura " +
        "Gómez, por $120.000. ¿Confirma?",
    );
  }
  if (body.includes('"booked"'))
    return text(params, "Listo, su cita quedó agendada. ¡La esperamos!");
  if (body.includes('"slots"') || body.includes("starts_at")) {
    return text(
      params,
      "El jueves 8 de octubre en la tarde tengo 2:00 p. m., 3:00 p. m. o 4:00 p. m. ¿Cuál prefiere?",
    );
  }
  return text(params, "Listo.");
}

function booking(confirmed: boolean): Record<string, unknown> {
  return {
    service_key: "limpieza",
    starts_at: "2026-10-08T15:00:00-05:00",
    subject_name: "Laura Gómez",
    for_self: true,
    confirmed_by_customer: confirmed,
  };
}

/** The open proposal the runtime lists in system block 2. */
function proposalId(params: Anthropic.MessageCreateParamsNonStreaming): string | null {
  const system = Array.isArray(params.system) ? params.system.map((b) => b.text).join("\n") : "";
  return /proposal_id ([0-9a-f-]{36})/.exec(system)?.[1] ?? null;
}

function customerText(param: Anthropic.MessageParam | undefined): string {
  if (!param) return "";
  if (typeof param.content === "string") return param.content;
  return param.content
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

let toolCounter = 0;

function text(params: Anthropic.MessageCreateParamsNonStreaming, body: string): Anthropic.Message {
  return message(params.model, [{ type: "text", text: body, citations: null }], "end_turn");
}

function tool(
  params: Anthropic.MessageCreateParamsNonStreaming,
  name: string,
  input: Record<string, unknown>,
): Anthropic.Message {
  toolCounter += 1;
  return message(
    params.model,
    [
      {
        type: "tool_use",
        id: `toolu_fake_${String(toolCounter)}`,
        name,
        input,
        caller: { type: "direct" },
      },
    ],
    "tool_use",
  );
}
