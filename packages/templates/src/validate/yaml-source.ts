import { LineCounter, isNode, parseDocument, type Document } from "yaml";
import type { DocPath } from "../issues.ts";

export interface ParsedSource {
  value: unknown;
  errors: { message: string; line?: number }[];
  /** 1-based line of the deepest existing node along `path`. */
  lineOf(path: DocPath): number | undefined;
}

/** YAML 1.2, duplicate keys rejected, alias expansion capped (no "billion laughs"). */
export function parseYamlSource(source: string): ParsedSource {
  const lineCounter = new LineCounter();
  const doc: Document = parseDocument(source, {
    lineCounter,
    uniqueKeys: true,
    prettyErrors: true,
  });

  const errors = doc.errors.map((e) => {
    const line = e.linePos?.[0].line;
    const message = e.message.split("\n")[0] ?? e.message;
    return line === undefined ? { message } : { message, line };
  });

  const lineOf = (path: DocPath): number | undefined => {
    for (let depth = path.length; depth >= 0; depth -= 1) {
      const node: unknown = doc.getIn(path.slice(0, depth), true);
      if (isNode(node) && node.range) return lineCounter.linePos(node.range[0]).line;
    }
    return undefined;
  };

  const value: unknown = errors.length > 0 ? null : doc.toJS({ maxAliasCount: 100 });
  return { value, errors, lineOf };
}
