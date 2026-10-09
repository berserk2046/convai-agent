import {
  getResource,
  listContactBookings,
  type BookingRow,
  type BusinessRow,
  type ContactRow,
  type Transaction,
} from "@platform/db";
import {
  TemplateRenderer,
  buildBookingContext,
  buildBusinessContext,
  buildContactContext,
  buildNowContext,
  tidy,
  type BookingFacts,
  type Context,
  type PreparedTemplate,
} from "@platform/templates";
import { DateTime } from "luxon";

/**
 * The automation render context (docs/templates.md): business, contact, now, and booking
 * (the subject) for booking triggers. Built with the same builders the validator uses, so
 * a rule that validated renders the same shapes here.
 */

const renderer = new TemplateRenderer();

export async function automationContext(
  tx: Transaction,
  input: {
    business: BusinessRow;
    prepared: PreparedTemplate;
    contact: ContactRow | null;
    booking: BookingRow | null;
    now: Date;
  },
): Promise<Context> {
  const { business, prepared, contact, booking } = input;
  const zone = business.timezone;
  const context: Context = {
    business: buildBusinessContext(business.config ?? {}, prepared.config.schema, zone),
    now: buildNowContext(DateTime.fromJSDate(input.now, { zone }), business.holidays.open_holidays),
  };
  if (contact) {
    const upcoming = await listContactBookings(tx, contact.id, { from: input.now });
    context.contact = buildContactContext(
      {
        name: contact.name,
        fields: contact.fields,
        upcomingBookings: upcoming.map((b) => bookingFacts(b, zone, null)),
      },
      Object.keys(prepared.template.contact_fields ?? {}),
    );
  }
  if (booking) {
    const resource = await getResource(tx, booking.resourceId);
    context.booking = buildBookingContext(bookingFacts(booking, zone, resource?.name ?? null));
  }
  return context;
}

export function bookingFacts(
  booking: BookingRow,
  zone: string,
  resourceName: string | null,
): BookingFacts {
  return {
    id: booking.id,
    service_key: booking.serviceKey,
    service_name: booking.serviceName,
    subject_name: booking.subjectName,
    party_size: booking.partySize,
    status: booking.status,
    source: booking.source,
    starts_at: DateTime.fromJSDate(booking.startsAt, { zone }),
    ends_at: DateTime.fromJSDate(booking.endsAt, { zone }),
    resource_name: resourceName,
    notes: booking.notes,
  };
}

/** Renders a rule's Liquid text (send_text, notify_staff, update_contact values). */
export function renderText(source: string, context: Context): string {
  return tidy(renderer.render(source, context));
}
