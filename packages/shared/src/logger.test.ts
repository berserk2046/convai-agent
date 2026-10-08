import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = {
    write(chunk: string) {
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  };
  return { lines, destination };
}

describe("createLogger", () => {
  it("redacts credentials and message bodies", () => {
    const { lines, destination } = capture();
    const logger = createLogger({ level: "info" }, destination);

    logger.info(
      {
        token: "EAAG-token",
        channel: { access_token: "EAAG-nested", phone_number_id: "123" },
        req: { headers: { authorization: "Bearer abc", cookie: "sid=1" } },
        message: { body: "Me duele una muela", wa_message_id: "wamid.1" },
        apiKey: "sk-ant-key",
      },
      "inbound",
    );

    const raw = JSON.stringify(lines);
    for (const secret of ["EAAG-token", "EAAG-nested", "Bearer abc", "sid=1", "sk-ant-key"]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).not.toContain("Me duele una muela");
    expect(lines[0]).toMatchObject({
      msg: "inbound",
      channel: { phone_number_id: "123" },
      message: { wa_message_id: "wamid.1" },
    });
  });

  it("respects the configured level", () => {
    const { lines, destination } = capture();
    const logger = createLogger({ level: "warn", name: "worker" }, destination);
    logger.info("hidden");
    logger.warn("shown");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: "shown", name: "worker" });
  });
});
