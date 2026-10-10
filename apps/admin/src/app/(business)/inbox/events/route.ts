import { SESSION_COOKIE, resolveSession } from "@platform/services";
import { cookies } from "next/headers";
import { inboxFeed, services } from "../../../../lib/server.ts";

/**
 * Server-sent events for open inbox tabs (ADR 0013): a "changed" event whenever something
 * the inbox shows changes for the actor's business. Events carry no data; the tab
 * re-renders, and the page checks the session as every page does.
 */

/** Keeps proxies from closing an idle stream, and re-checks the session each time. */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const businessId = (await resolveSession(services(), token))?.business?.id;
  if (!businessId) return new Response(null, { status: 401 });
  const feed = inboxFeed();
  await feed.ready();

  const encoder = new TextEncoder();
  let release: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (chunk: string) => {
        if (open) controller.enqueue(encoder.encode(chunk));
      };
      const unsubscribe = feed.subscribe(businessId, () => {
        send("data: changed\n\n");
      });
      // Logged out, or switched business: end the stream. The browser reconnects, and
      // the new request subscribes to the right business or gets a 401.
      const heartbeat = setInterval(() => {
        resolveSession(services(), token).then(
          (actor) => {
            if (actor?.business?.id === businessId) send(": ping\n\n");
            else close();
          },
          () => {
            close();
          },
        );
      }, HEARTBEAT_MS);
      const stop = () => {
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
      };
      const close = () => {
        if (!open) return;
        stop();
        controller.close();
      };
      release = stop;
      request.signal.addEventListener("abort", stop);
      send("retry: 3000\n\n");
    },
    cancel() {
      release?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform: Next's compression skips the response; compressing would buffer it.
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
