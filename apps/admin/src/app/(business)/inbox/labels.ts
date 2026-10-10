/**
 * Handoff reasons and summaries in words staff read. The reasons the model picks are slugs
 * the template declares (`urgencia`, `pide_humano`), and the template names them
 * (`agent.tools.handoff.labels`). The runtime's own reasons and fixed summaries are English
 * in code, so they're translated here. A reason with neither shows humanized.
 */

const SYSTEM_REASONS: Record<string, string> = {
  staff: "Atiende el equipo",
  error: "Falla del asistente",
  price_guard: "Precio por confirmar",
  budget: "Límite de gasto del asistente",
};

export function reasonLabel(reason: string, templateLabel?: string | null): string {
  const known = templateLabel ?? SYSTEM_REASONS[reason];
  if (known) return known;
  const words = reason.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const SYSTEM_SUMMARIES: Record<string, string> = {
  "Emergency keywords in the customer's message":
    "El mensaje del cliente tiene palabras de urgencia.",
  "Monthly AI budget reached": "Se alcanzó el límite mensual de gasto del asistente.",
  "The configured AI model has no known price":
    "El asistente no está bien configurado (modelo sin precio).",
  "The assistant could not answer (AI service error)":
    "El asistente no pudo responder (falla del servicio de IA).",
  "The model returned no reply": "El asistente no generó respuesta.",
  "The model declined to answer": "El asistente no quiso responder.",
  "Too many tool calls in one turn": "El asistente se enredó con la consulta.",
  "The assistant tried to quote a price that isn't in the catalog":
    "El asistente intentó dar un precio que no está en la lista de servicios.",
};

export function summaryText(summary: string | null): string | null {
  if (summary === null) return null;
  return SYSTEM_SUMMARIES[summary] ?? summary;
}
