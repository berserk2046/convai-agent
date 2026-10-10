/**
 * WhatsApp ids are the full number in digits, country code included (573001234567).
 * Staff type numbers the Colombian way ("300 123 4567", "+57 300…"): a 10-digit mobile or
 * landline gets the 57 prefix.
 */
export function normalizeWaNumber(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (/^(3\d{9}|60\d{8})$/.test(digits)) return `57${digits}`;
  if (/^57(3\d{9}|60\d{8})$/.test(digits)) return digits;
  // Another country: needs its code; WhatsApp numbers are 8 to 15 digits long.
  if (input.trim().startsWith("+") && /^[1-9]\d{7,14}$/.test(digits)) return digits;
  return null;
}
