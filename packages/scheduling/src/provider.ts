/**
 * Calendar providers (spec §8). The built-in provider is the source of truth: busy time
 * comes from our bookings and closures tables, so it adds nothing. The Google provider
 * (M8) will add busy blocks from mapped calendars and mirror bookings as events.
 */

export interface BusyBlock {
  resourceId: string;
  start: Date;
  end: Date;
}

export interface ProviderBooking {
  id: string;
  resourceId: string;
  start: Date;
  end: Date;
  title: string;
  externalRef: string | null;
}

export interface SchedulingProvider {
  getBusy(resourceIds: readonly string[], range: { from: Date; to: Date }): Promise<BusyBlock[]>;
  /** Returns the external event id, if the provider keeps one. */
  createEvent(booking: ProviderBooking): Promise<string | null>;
  updateEvent(booking: ProviderBooking): Promise<void>;
  deleteEvent(booking: ProviderBooking): Promise<void>;
}

export const builtinProvider: SchedulingProvider = {
  getBusy: () => Promise.resolve([]),
  createEvent: () => Promise.resolve(null),
  updateEvent: () => Promise.resolve(),
  deleteEvent: () => Promise.resolve(),
};
