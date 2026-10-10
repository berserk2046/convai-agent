import { describe, expect, it } from "vitest";
import { issueText } from "./issue-text.ts";

describe("issueText", () => {
  it("puts Ajv's and the server's messages in Spanish", () => {
    expect(issueText("is required")).toBe("es obligatorio");
    expect(issueText("must be >= 5")).toBe("debe ser mayor o igual a 5");
    expect(issueText('must be one of "fixed", "from"')).toBe("no es una opción válida");
    expect(issueText("opens at 12:00 but closes at 08:00")).toBe(
      "abre a las 12:00 pero cierra a las 08:00",
    );
  });

  it("leaves messages it doesn't know as they are", () => {
    expect(issueText("La contraseña es demasiado corta.")).toBe(
      "La contraseña es demasiado corta.",
    );
  });
});
