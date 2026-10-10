/** /bookings URLs: the date, the view and what the side panel shows live in the query. */
export function bookingsHref(params: {
  date?: string;
  view?: "day" | "week";
  booking?: string;
  new?: boolean;
  block?: boolean;
  at?: string;
  resource?: string | undefined;
}): string {
  const query = new URLSearchParams();
  if (params.date) query.set("date", params.date);
  if (params.view === "week") query.set("view", "week");
  if (params.booking) query.set("booking", params.booking);
  if (params.new) query.set("new", "1");
  if (params.block) query.set("block", "1");
  if (params.at) query.set("at", params.at);
  if (params.resource) query.set("resource", params.resource);
  const text = query.toString();
  return text === "" ? "/bookings" : `/bookings?${text}`;
}
