import type { CoreDeps, EventSink } from "@platform/core";
import type { SchedulingProvider } from "@platform/scheduling";

/** A run to put on the automations queue; it waits there until `dueAt`. */
export interface QueuedRun {
  id: string;
  businessId: string;
  dueAt: Date;
}

/** What the automations engine needs from the outside world; tests swap in fakes. */
export interface AutomationDeps extends CoreDeps {
  enqueue: (run: QueuedRun) => Promise<void>;
  /** Monthly marketing-message cap for businesses without their own (principle 10). */
  marketingMsgsMonth: number;
  /** Booking events from automation actions (an update_booking cancellation). */
  events: EventSink;
  provider: SchedulingProvider;
}
