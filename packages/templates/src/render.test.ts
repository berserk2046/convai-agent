import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  buildBusinessContext,
  buildContactContext,
  buildNowContext,
  resolveBookingRules,
  agentSettings,
} from "./context.ts";
import { TemplateRenderer } from "./liquid.ts";
import { prepareTemplate, validateBusinessConfig } from "./prepared.ts";
import { renderDynamicBlock, renderSystemBlock, tidy } from "./render.ts";
import { validateTemplateSource } from "./validate/index.ts";

const source = readFileSync(
  new URL("../../../templates/odontologia/template.yaml", import.meta.url),
  "utf8",
);
const template = validateTemplateSource(source).template;
if (!template?.booking) throw new Error("odontologia must validate");

const prepared = prepareTemplate(template);
const configResult = validateBusinessConfig(prepared, template.sample_config);
if (!configResult.ok) throw new Error("sample_config must validate");
const config = configResult.value;
const business = buildBusinessContext(config, prepared.config.schema, "America/Bogota");
const rules = resolveBookingRules(template.booking, config);
const renderer = new TemplateRenderer();

describe("odontologia system prompt with sample_config", () => {
  const block = renderSystemBlock(renderer, template, business, rules);

  it("renders the expected text", async () => {
    await expect(block).toMatchFileSnapshot("./__snapshots__/odontologia.system-block.txt");
  });

  it("is byte-identical across renders, so prompt caching can work", () => {
    expect(renderSystemBlock(new TemplateRenderer(), template, business, rules)).toBe(block);
  });

  it("states prices exactly as the catalog has them", () => {
    expect(block).toContain("- Limpieza dental: $120.000, 45 min.");
    expect(block).toContain("- Resina (calza): desde $180.000, 60 min.");
    expect(block).toContain(
      "- Endodoncia: precio tras valoración, 90 min. (no se agenda por WhatsApp)",
    );
  });

  it("never leaks placeholders like null or undefined", () => {
    expect(block).not.toMatch(/\bnull\b|\bundefined\b|\[object Object\]/);
  });
});

describe("odontologia dynamic context", () => {
  const now = buildNowContext(
    DateTime.fromISO("2026-10-05T09:00:00-05:00").setZone("America/Bogota"),
  );

  it("renders date, calendar and the patient's bookings", async () => {
    const start = DateTime.fromISO("2026-10-06T10:00:00", { zone: "America/Bogota" });
    const contact = buildContactContext(
      {
        name: "Ana Pérez",
        fields: {},
        upcomingBookings: [
          {
            id: "7d3c2f1e-0000-4000-8000-000000000001",
            service_key: "valoracion",
            service_name: "Valoración",
            subject_name: "Ana Pérez",
            party_size: null,
            status: "confirmed",
            source: "agent",
            starts_at: start,
            ends_at: start.plus({ minutes: 30 }),
            resource_name: "Sillón 1",
            notes: null,
          },
        ],
      },
      Object.keys(template.contact_fields ?? {}),
    );
    const text = renderDynamicBlock(renderer, template, {
      business,
      agent: agentSettings(template),
      booking: rules,
      now,
      contact,
    });
    await expect(text).toMatchFileSnapshot("./__snapshots__/odontologia.dynamic-context.txt");
  });

  it("handles an unknown patient with no bookings", () => {
    const contact = buildContactContext({ name: null, fields: {}, upcomingBookings: [] }, []);
    const text = renderDynamicBlock(renderer, template, {
      business,
      agent: agentSettings(template),
      booking: rules,
      now,
      contact,
    });
    expect(text).toContain("Paciente: nombre aún desconocido.");
    expect(text).toContain("- jueves 8 de octubre: 2026-10-08");
    expect(text).not.toContain("Citas próximas");
  });
});

describe("tidy", () => {
  it("drops trailing spaces and collapses blank-line runs", () => {
    expect(tidy("a  \n\n\n\nb\n  \n")).toBe("a\n\nb");
  });
});
