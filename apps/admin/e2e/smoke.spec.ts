import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { ODONTOLOGIA_VERSION } from "@platform/db/testing";
import { holidayOn } from "@platform/shared";
import { closeCustomer, customerSays, toolResult } from "./customer.ts";
import { E2E } from "./env.ts";
import { finishQueuedEvalRun } from "./worker.ts";

/**
 * Spec §15 M5 "done when": create a dental business from the UI, fill in the generated
 * setup form, add 2 chairs, see bookings created by the agent, answer a handoff from the
 * inbox, and return the conversation to the bot. One test, in order, like a real setup.
 * M6 adds the eval gate before publishing and a chat in the playground.
 */

const TEMPLATE = fileURLToPath(
  new URL("../../../templates/odontologia/template.yaml", import.meta.url),
);
const ADMIN = { email: "ana@sonrisas.test", password: "clave-temporal-e2e" };
const LAURA = "573001234001";

/** The next weekday at least two days ahead that isn't a public holiday (Colombia is UTC−5, no DST). */
function bookingDate(): string {
  for (let days = 2; days < 30; days += 1) {
    const at = new Date(Date.now() - 5 * 3_600_000 + days * 86_400_000);
    const date = at.toISOString().slice(0, 10);
    const weekday = at.getUTCDay();
    if (weekday >= 1 && weekday <= 5 && !holidayOn(date)) return date;
  }
  throw new Error("no weekday in the next month");
}

async function login(page: Page, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
}

/** The form that holds a given submit button. */
const formWith = (page: Page, button: string) =>
  page.locator("form").filter({ has: page.getByRole("button", { name: button, exact: true }) });

test.afterAll(async () => {
  await closeCustomer();
});

test("M5: set up a dental business, let the agent book, answer a handoff, hand back to the bot", async ({
  page,
}) => {
  let businessId = "";
  const date = bookingDate();

  await test.step("the owner uploads and publishes the dental template", async () => {
    await login(page, E2E.ownerEmail, E2E.ownerPassword);
    await expect(page).toHaveURL(/\/businesses$/);
    await page.goto("/templates");
    await page.getByLabel("Template YAML file").setInputFiles(TEMPLATE);
    await page.getByRole("button", { name: "Validate and save as draft" }).click();
    await page.getByRole("link", { name: "Review and publish" }).click();

    // Spec §10: publishing waits for a live eval run that passes the gate.
    await expect(page.getByText("Not publishable yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
    await page.getByRole("button", { name: "Run evals" }).click();
    await expect(page.getByText("Eval run queued")).toBeVisible();
    await finishQueuedEvalRun();
    // The page follows the run on its own while it's in progress.
    await expect(page.getByText("passed the gate")).toBeVisible();
    await page.getByRole("link", { name: "Report" }).click();
    await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
    await expect(page.getByRole("link", { name: "agenda_simple" })).toBeVisible();
    await page.goBack();

    await page.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByRole("button", { name: "Deprecate" })).toBeVisible();
  });

  await test.step("the owner tries the template in the playground; nothing reaches WhatsApp", async () => {
    await page.getByRole("link", { name: "Try it in the playground" }).click();
    await page.getByRole("button", { name: "Start a chat" }).click();
    await page.waitForURL(/\/playground\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/Sandbox ready with the template's sample config/)).toBeVisible();

    const message = page.getByLabel("Message as the customer");
    await message.fill("Hola, ¿cuánto vale una limpieza?");
    await message.press("Enter");
    await expect(page.getByText("La limpieza dental tiene un valor de $120.000.")).toBeVisible();
    await expect(page.getByText(/0 tool call\(s\) · \d+ in \/ \d+ out tokens/)).toBeVisible();

    // An emergency: the template's fixed reply, a handoff, and the bot goes quiet.
    await message.fill("Me duele muchísimo y tengo la cara hinchada");
    await message.press("Enter");
    await expect(page.getByText("Staff (the bot is silent)")).toBeVisible();
    await page.getByRole("button", { name: "Close handoff, back to the bot" }).click();
    await expect(page.getByText("The bot", { exact: true })).toBeVisible();

    const sent = (await (
      await fetch(`${process.env.META_GRAPH_BASE_URL ?? ""}/__requests`)
    ).json()) as unknown[];
    expect(sent).toHaveLength(0);
    await page.getByRole("button", { name: "End chat" }).click();
    await expect(page.getByText("This chat has ended.")).toBeVisible();
  });

  await test.step("the owner creates the business, connects WhatsApp and adds its admin", async () => {
    await page.goto("/businesses/new");
    await page.getByLabel("Name").fill("Sonrisas E2E");
    await page.getByLabel("Template").selectOption(`odontologia@${ODONTOLOGIA_VERSION}`);
    await page.getByRole("button", { name: "Create business" }).click();
    await page.waitForURL(/\/businesses\/[0-9a-f-]{36}$/);
    businessId = page.url().split("/").at(-1) ?? "";

    const channel = formWith(page, "Connect channel");
    await channel.getByLabel("Phone number ID").fill(E2E.phoneNumberId);
    await channel.getByLabel("WhatsApp Business Account ID").fill("102290129340398");
    await channel.getByLabel("Display phone").fill("+57 300 000 0000");
    await channel.getByLabel("Access token").fill("EAAG-e2e-token");
    await channel.getByRole("button", { name: "Connect channel" }).click();
    await expect(page.getByText("Channel connected.")).toBeVisible();

    const user = formWith(page, "Add user");
    await user.getByLabel("Email").fill(ADMIN.email);
    await user.getByLabel("Name").fill("Ana Admin");
    await user.getByLabel("Temporary password").fill(ADMIN.password);
    await user.getByRole("button", { name: "Add user" }).click();
    await expect(page.getByRole("cell", { name: ADMIN.email, exact: true })).toBeVisible();
  });

  await test.step("the business admin fills in the generated setup form", async () => {
    await login(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/inbox$/);
    await page.goto("/setup");
    await page.locator("#root_business_name").fill("Sonrisas E2E");
    await page.locator("#root_address").fill("Calle 10 # 43-20");
    await page.locator("#root_phone_urgencias").fill("300 123 4567");
    // Monday to Friday, 8:00 to 12:00 (the first range each "+ Horario" adds).
    const addRange = page.getByRole("button", { name: "+ Horario" });
    for (let day = 0; day < 5; day += 1) await addRange.nth(day).click();

    // `minItems: 1`: the form starts with one empty service row.
    await page.locator("#root_services_0_key").fill("limpieza");
    await page.locator("#root_services_0_name").fill("Limpieza dental");
    // The choice shows the template's name for it (x-ui labels); "fixed" is what's stored.
    await page.locator("#root_services_0_price_type").selectOption({ label: "Precio fijo" });
    await page.locator("#root_services_0_price_cop").fill("120000");
    await page.locator("#root_services_0_duration_min").fill("45");
    await page.locator("#root_payment_methods").getByRole("button", { name: "+ Agregar" }).click();
    await page.locator("#root_payment_methods_0").fill("Efectivo");

    await page.getByRole("button", { name: "Guardar datos del negocio" }).click();
    await expect(page.getByText("Cambios guardados.")).toBeVisible();
  });

  await test.step("the business admin adds two chairs", async () => {
    for (const name of ["Sillón 1", "Sillón 2"]) {
      const form = formWith(page, "Agregar");
      await form.getByLabel("Nuevo: Sillón").fill(name);
      await form.getByRole("button", { name: "Agregar", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Nombre", exact: true }).last()).toHaveValue(
        name,
      );
    }
    await expect(page.getByRole("textbox", { name: "Nombre", exact: true })).toHaveCount(2);
  });

  await test.step("the owner activates the business", async () => {
    await login(page, E2E.ownerEmail, E2E.ownerPassword);
    await page.goto(`/businesses/${businessId}`);
    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.getByText("active", { exact: true })).toBeVisible();
  });

  await test.step("a customer books through the agent", async () => {
    const availability = {
      name: "check_availability",
      input: {
        service_key: "limpieza",
        date_from: date,
        date_to: date,
        time_of_day: "morning",
        around_time: "10:00",
      },
    };
    const book = {
      service_key: "limpieza",
      starts_at: `${date}T10:00:00-05:00`,
      subject_name: "Laura Gómez",
      for_self: true,
      confirmed_by_customer: false,
    };
    const first = await customerSays(
      LAURA,
      "Quiero una limpieza a las 10 de la mañana. Soy Laura Gómez",
      [
        { tools: [availability] },
        { tools: [{ name: "book", input: book }] },
        { text: "Le confirmo la limpieza dental a las 10:00 a. m. ¿La agendo?" },
      ],
    );
    const proposal = toolResult(first.llm, 2);
    expect(proposal).toMatchObject({ status: "needs_confirmation" });

    const second = await customerSays(LAURA, "Sí, confirmo", [
      {
        tools: [
          {
            name: "book",
            input: { ...book, confirmed_by_customer: true, proposal_id: proposal?.proposal_id },
          },
        ],
      },
      { text: "¡Listo! Su cita quedó agendada." },
    ]);
    expect(toolResult(second.llm, 1)).toMatchObject({ status: "booked" });
  });

  await test.step("the admin sees the agent's booking", async () => {
    await login(page, ADMIN.email, ADMIN.password);
    await page.goto(`/bookings?date=${date}`);
    const chip = page.getByRole("link", { name: /Laura Gómez/ });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByText("Agendada por el asistente")).toBeVisible();
    await expect(page.getByText("Sin confirmar", { exact: true })).toBeVisible();
  });

  await test.step("an emergency shows in the open inbox right away, with no reload", async () => {
    await page.goto("/inbox");
    await expect(page.getByText("Nadie está esperando.")).toBeVisible();

    // The fixed safe reply goes out and a person takes over (principle 5). The inbox has
    // no polling: only the server's change event can make the item appear (ADR 0013).
    const emergency = await customerSays(LAURA, "Tengo la cara hinchada y fiebre", []);
    expect(emergency.llm.requests).toHaveLength(0);
    const item = page.getByRole("link", { name: /Laura Gómez/ });
    await expect(item.getByText("Urgencia", { exact: true })).toBeVisible();

    await item.click();
    await expect(page.getByText("Atiende una persona · Urgencia")).toBeVisible();
    await expect(page.getByText("Limpieza dental", { exact: true })).toBeVisible();

    // The open conversation updates too. The bot stays silent while a person attends.
    const followUp = await customerSays(LAURA, "¿Me pueden llamar?", []);
    expect(followUp.llm.requests).toHaveLength(0);
    await expect(
      page.getByRole("list", { name: "Mensajes" }).getByText("¿Me pueden llamar?"),
    ).toBeVisible();
  });

  await test.step("the admin answers the handoff and gives the conversation back to the bot", async () => {
    const reply = "Hola Laura, la llamamos en 5 minutos.";
    await page.getByLabel("Respuesta").fill(reply);
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByRole("list", { name: "Mensajes" }).getByText(reply)).toBeVisible();

    // It reached WhatsApp (the fake Graph API) as a text to Laura.
    const sent = (await (
      await fetch(`${process.env.META_GRAPH_BASE_URL ?? ""}/__requests`)
    ).json()) as {
      body: { to?: string; text?: { body?: string } };
    }[];
    expect(sent.some((r) => r.body.to === LAURA && r.body.text?.body === reply)).toBe(true);

    await page.getByRole("button", { name: "Devolver al asistente" }).click();
    await expect(page.getByText("Atiende el asistente", { exact: true })).toBeVisible();
    await page.goto("/inbox");
    await expect(page.getByText("Nadie está esperando.")).toBeVisible();
  });

  await test.step("other tenants' ids and owner screens are not found", async () => {
    await page.goto("/inbox/00000000-0000-4000-8000-000000000000");
    await expect(page.getByText("No se encontró la página")).toBeVisible();
    await page.goto(`/businesses/${businessId}`);
    await expect(page.getByText("No se encontró la página")).toBeVisible();
  });
});
