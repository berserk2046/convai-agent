/**
 * Validation messages (Ajv's, as RJSF and the service layer report them) in Spanish, for
 * business users. Pure, so client forms can use it too.
 */
export function issueText(message: string): string {
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^is required$/, () => "es obligatorio"],
    [/^must have required property/, () => "es obligatorio"],
    [/^is a required property$/, () => "es obligatorio"],
    [/^must not be empty$/, () => "no puede estar vacío"],
    [/^must be >= (\S+)$/, (m) => `debe ser mayor o igual a ${m[1] ?? ""}`],
    [/^must be <= (\S+)$/, (m) => `debe ser menor o igual a ${m[1] ?? ""}`],
    [/^must be > (\S+)$/, (m) => `debe ser mayor que ${m[1] ?? ""}`],
    [/^must be multiple of (\S+)$/, (m) => `debe ser múltiplo de ${m[1] ?? ""}`],
    [/^must be integer$/, () => "debe ser un número entero"],
    [/^must be number$/, () => "debe ser un número"],
    [/^must be string$/, () => "debe ser texto"],
    [/^must match pattern/, () => "no tiene el formato esperado"],
    [/^must match format "uri"$/, () => "debe ser un enlace (https://…)"],
    [/^must NOT have fewer than (\d+) items$/, (m) => `necesita al menos ${m[1] ?? ""}`],
    [/^must be equal to one of the allowed values$/, () => "no es una opción válida"],
    [/^must be one of /, () => "no es una opción válida"],
    [/^is not allowed$/, () => "no se permite"],
    [
      /^opens at (\S+) but closes at (\S+)$/,
      (m) => `abre a las ${m[1] ?? ""} pero cierra a las ${m[2] ?? ""}`,
    ],
    [/^overlaps or is out of order/, () => "se cruza con otro horario o está fuera de orden"],
  ];
  for (const [pattern, text] of rules) {
    const match = pattern.exec(message);
    if (match) return text(match);
  }
  return message;
}
