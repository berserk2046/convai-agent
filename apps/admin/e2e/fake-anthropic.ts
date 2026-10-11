import { createServer } from "node:http";
import type { Anthropic } from "@platform/llm";
import { fakeDentalLlm } from "@platform/evals/testing";
import { E2E } from "./env.ts";

/**
 * The Anthropic Messages API stand-in for the admin's playground: the real SDK posts to
 * it (ANTHROPIC_BASE_URL) and gets the rule-based dental fake's answers. GET /__requests
 * returns how many calls it served. Runs until Playwright stops it.
 */
const llm = fakeDentalLlm();

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__requests") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ count: llm.requests.length }));
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no" } }));
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const params = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as Anthropic.MessageCreateParamsNonStreaming;
    void llm.createMessage(params).then((message) => {
      res.writeHead(200, { "content-type": "application/json", "request-id": "req_e2e" });
      res.end(JSON.stringify(message));
    });
  });
});

server.listen(E2E.anthropicPort, "127.0.0.1", () => {
  console.log(`fake Anthropic API on http://127.0.0.1:${String(E2E.anthropicPort)}`);
});
