import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test helpers: Meta's recorded webhook payloads, and a local fake of the Graph API that
 * records what we send. Real HTTP, so tests exercise the actual client code.
 */

export type FixtureName =
  | "text-message"
  | "button-message"
  | "interactive-list-reply"
  | "interactive-button-reply"
  | "reaction-message"
  | "reaction-removed"
  | "image-message"
  | "unsupported-message"
  | "status-sent"
  | "status-sent-minimal"
  | "status-failed";

/** A fresh copy of a recorded webhook payload (see fixtures/README.md). */
export function webhookFixture(name: FixtureName): Record<string, unknown> {
  const file = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

export interface FakeResponse {
  status: number;
  body: unknown;
}

export interface FakeGraph {
  /** Base URL to use as META_GRAPH_BASE_URL. */
  url: string;
  requests: RecordedRequest[];
  /** Queue responses for the next requests; afterwards each request succeeds. */
  respondNext(...responses: FakeResponse[]): void;
  close(): Promise<void>;
}

export async function startFakeGraph(): Promise<FakeGraph> {
  const requests: RecordedRequest[] = [];
  const queued: FakeResponse[] = [];
  let counter = 0;

  const server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });
      counter += 1;
      const response = queued.shift() ?? {
        status: 200,
        body: {
          messaging_product: "whatsapp",
          contacts: [{ input: body.to, wa_id: body.to }],
          messages: [
            { id: `wamid.FAKE${String(counter).padStart(6, "0")}`, message_status: "accepted" },
          ],
        },
      };
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respondNext: (...responses) => queued.push(...responses),
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
