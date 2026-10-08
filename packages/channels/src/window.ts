/**
 * WhatsApp's customer service window: free-form messages are allowed for 24 hours after
 * the person's last message. Outside it, only approved templates can be sent.
 */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ServiceWindow {
  open: boolean;
  /** When free-form messages stop being allowed; null if the person never wrote. */
  closesAt: Date | null;
}

export function serviceWindow(lastInboundAt: Date | null, now: Date): ServiceWindow {
  if (lastInboundAt === null) return { open: false, closesAt: null };
  const closesAt = new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS);
  return { open: now < closesAt, closesAt };
}
