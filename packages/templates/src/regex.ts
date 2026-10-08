/**
 * Template regexes (consent accept patterns, emergency patterns, eval reply_not_matches)
 * always compile with the `iu` flags (spec §7). In JavaScript `\b` only knows ASCII word
 * characters, so `s[ií]\b` never matches "sí": the validator rejects `\b` next to a
 * non-ASCII letter.
 */

export const TEMPLATE_REGEX_FLAGS = "iu";

export function compileTemplateRegex(source: string): RegExp {
  return new RegExp(source, TEMPLATE_REGEX_FLAGS);
}

/** Returns a problem description, or null if the pattern is fine. */
export function checkTemplateRegex(source: string): string | null {
  try {
    compileTemplateRegex(source);
  } catch (error) {
    return `does not compile with the "${TEMPLATE_REGEX_FLAGS}" flags: ${(error as Error).message}`;
  }
  const atoms = tokenize(source);
  for (const [i, atom] of atoms.entries()) {
    if (atom.kind !== "boundary") continue;
    const before = previousAtom(atoms, i);
    const after = atoms[i + 1];
    if ((before && hasNonAsciiLetter(before)) || (after && hasNonAsciiLetter(after))) {
      return (
        "uses \\b next to a non-ASCII letter; \\b is ASCII-only in JavaScript, so it never " +
        "matches there. Use a lookahead like (?![a-záéíóúñ]) instead"
      );
    }
  }
  return null;
}

type Atom =
  | { kind: "boundary" }
  | { kind: "quantifier" }
  | { kind: "literal" | "class" | "other"; text: string };

/** A coarse tokenizer: enough to see what sits on each side of `\b`. */
function tokenize(source: string): Atom[] {
  const atoms: Atom[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === "\\") {
      const next = source[i + 1] ?? "";
      atoms.push(
        next === "b" || next === "B" ? { kind: "boundary" } : { kind: "other", text: next },
      );
      i += 2;
    } else if (ch === "[") {
      let j = i + 1;
      while (j < source.length && source[j] !== "]") j += source[j] === "\\" ? 2 : 1;
      atoms.push({ kind: "class", text: source.slice(i, j + 1) });
      i = j + 1;
    } else if ("*+?".includes(ch)) {
      atoms.push({ kind: "quantifier" });
      i += 1;
    } else if (ch === "{" && /^\{\d+(,\d*)?\}/.test(source.slice(i))) {
      atoms.push({ kind: "quantifier" });
      i = source.indexOf("}", i) + 1;
    } else {
      atoms.push({ kind: "literal", text: ch });
      i += 1;
    }
  }
  return atoms;
}

function previousAtom(atoms: Atom[], index: number): Atom | undefined {
  let i = index - 1;
  while (i >= 0 && atoms[i]?.kind === "quantifier") i -= 1;
  return atoms[i];
}

function hasNonAsciiLetter(atom: Atom): boolean {
  if (atom.kind !== "literal" && atom.kind !== "class") return false;
  // A letter that isn't ASCII: á, í, ñ…
  return /(?!\p{ASCII})\p{L}/u.test(atom.text);
}
