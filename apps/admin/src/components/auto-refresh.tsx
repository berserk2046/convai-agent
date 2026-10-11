"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the page's server components every few seconds while it's mounted: for
 * pages showing work that runs elsewhere, such as an eval run in the worker. Render it
 * only while that work is in progress.
 */
export function AutoRefresh({ everyMs = 3_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => {
      clearInterval(timer);
    };
  }, [router, everyMs]);
  return null;
}
