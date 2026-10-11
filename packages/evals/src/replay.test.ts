import type { Anthropic } from "@platform/llm";
import { scriptedLlm } from "@platform/llm/testing";
import { describe, expect, it } from "vitest";
import {
  ReplayMissError,
  UuidNormalizer,
  canonicalJson,
  recordingLlm,
  replayLlm,
  requestKey,
  type RecordedCall,
} from "./replay.ts";

const A = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const B = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";
const C = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const D = "9c858901-8a57-4791-81fe-4c455b099bc9";

function request(text: string): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: "claude-haiku-4-5",
    max_tokens: 100,
    messages: [{ role: "user", content: text }],
  };
}

describe("UuidNormalizer", () => {
  it("numbers UUIDs by first appearance and maps them back", () => {
    const n = new UuidNormalizer();
    expect(n.normalize({ a: A, list: [B, A] })).toEqual({
      a: "<uuid:1>",
      list: ["<uuid:2>", "<uuid:1>"],
    });
    expect(n.restore({ id: "<uuid:2>" })).toEqual({ id: B });
  });

  it("gives an unknown placeholder a stable fake id", () => {
    const n = new UuidNormalizer();
    const fake = n.restore("<uuid:7>");
    expect(fake).toMatch(/^00000000-0000-4000-8000-0{11}7$/);
    expect(n.normalize(fake)).toBe("<uuid:7>");
  });
});

describe("requestKey", () => {
  it("ignores key order and which UUIDs a run happened to get", () => {
    const first = requestKey(request(`booking ${A}, proposal ${B}`), new UuidNormalizer());
    const second = requestKey(request(`booking ${C}, proposal ${D}`), new UuidNormalizer());
    expect(first).toBe(second);
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("changes when the text changes", () => {
    const n = new UuidNormalizer();
    expect(requestKey(request("hola"), n)).not.toBe(requestKey(request("hola!"), n));
  });
});

describe("record and replay", () => {
  it("replays a recorded conversation with this run's ids in the model's tool input", async () => {
    const calls: RecordedCall[] = [];
    const live = scriptedLlm([{ tools: [{ name: "cancel", input: { booking_id: A } }] }]);
    const recorder = recordingLlm(live, calls);
    await recorder.createMessage(request(`your booking is ${A}`));
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.response)).toContain("<uuid:1>");
    expect(JSON.stringify(calls[0]?.response)).not.toContain(A);

    // Another run: the database gave the booking another id.
    const replay = replayLlm({ calls }, "cancelar");
    const response = await replay.createMessage(request(`your booking is ${C}`));
    const use = response.content.find((b) => b.type === "tool_use");
    expect(use?.input).toEqual({ booking_id: C });
  });

  it("fails loudly when a request wasn't recorded", async () => {
    const replay = replayLlm({ calls: [] }, "precio_limpieza");
    await expect(replay.createMessage(request("hola"))).rejects.toBeInstanceOf(ReplayMissError);
    await expect(replayLlm(undefined, "x").createMessage(request("hola"))).rejects.toThrow(
      /Re-record/,
    );
  });

  it("uses each recorded response once, in order, for identical requests", async () => {
    const calls: RecordedCall[] = [];
    const recorder = recordingLlm(scriptedLlm([{ text: "uno" }, { text: "dos" }]), calls);
    await recorder.createMessage(request("otra vez"));
    await recorder.createMessage(request("otra vez"));
    const replay = replayLlm({ calls }, "x");
    const texts = [];
    for (let i = 0; i < 2; i += 1) {
      const r = await replay.createMessage(request("otra vez"));
      texts.push(r.content[0]?.type === "text" ? r.content[0].text : "");
    }
    expect(texts).toEqual(["uno", "dos"]);
  });
});
