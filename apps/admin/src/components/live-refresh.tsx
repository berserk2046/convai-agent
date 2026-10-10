"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the page's server components as soon as the server says something changed
 * (server-sent events from `url`, ADR 0013). Form inputs keep their state. A hidden tab
 * disconnects, and catches up when it's shown again.
 */
export function LiveRefresh({ url }: { url: string }) {
  const router = useRouter();
  useEffect(() => {
    let source: EventSource | null = null;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let connectedBefore = false;

    // A burst (a reply, then its delivery and read statuses) becomes one re-render.
    const refresh = () => {
      pending ??= setTimeout(() => {
        pending = undefined;
        router.refresh();
      }, 150);
    };
    const disconnect = () => {
      source?.close();
      source = null;
    };
    const connect = () => {
      if (source) return;
      const next = new EventSource(url);
      next.onmessage = refresh;
      next.onopen = () => {
        // Back after a drop or a hidden spell: changes may have been missed.
        if (connectedBefore) refresh();
        connectedBefore = true;
      };
      next.onerror = () => {
        // CLOSED means the server refused (logged out): the refresh goes to the login page.
        // Otherwise the browser is already reconnecting.
        if (next.readyState === EventSource.CLOSED) {
          disconnect();
          refresh();
        }
      };
      source = next;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") connect();
      else disconnect();
    };

    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      disconnect();
      clearTimeout(pending);
    };
  }, [router, url]);
  return null;
}
