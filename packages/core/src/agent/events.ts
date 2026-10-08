import type { Logger } from "@platform/shared";
import type { EventSink } from "./tools/types.ts";

/** Until M4's automations consume booking events, they're logged. */
export function loggingEventSink(logger: Logger): EventSink {
  return {
    emit(event) {
      logger.info(
        { event: event.type, business_id: event.businessId, booking_id: event.bookingId },
        "booking event",
      );
      return Promise.resolve();
    },
  };
}
