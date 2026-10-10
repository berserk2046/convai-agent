-- Instant inbox refresh (ADR 0013). Any change to what the inbox shows sends a NOTIFY on
-- `inbox_changed` with the business id as the payload (never message text). The admin
-- LISTENs and tells that business's open inbox tabs to re-render.
--
-- Postgres delivers notifications at commit, so listeners never see uncommitted rows, and
-- sends identical ones from the same transaction once: a status batch is one refresh.
-- Triggers catch every writer (webhook API, worker, admin) without code in each path.
CREATE FUNCTION notify_inbox_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('inbox_changed', COALESCE(NEW.business_id, OLD.business_id)::text);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER messages_inbox_changed AFTER INSERT OR UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION notify_inbox_changed();
--> statement-breakpoint
CREATE TRIGGER conversations_inbox_changed AFTER INSERT OR UPDATE OR DELETE ON conversations
  FOR EACH ROW EXECUTE FUNCTION notify_inbox_changed();
--> statement-breakpoint
CREATE TRIGGER contacts_inbox_changed AFTER INSERT OR UPDATE OR DELETE ON contacts
  FOR EACH ROW EXECUTE FUNCTION notify_inbox_changed();
--> statement-breakpoint
CREATE TRIGGER handoffs_inbox_changed AFTER INSERT OR UPDATE OR DELETE ON handoffs
  FOR EACH ROW EXECUTE FUNCTION notify_inbox_changed();
--> statement-breakpoint
CREATE TRIGGER staff_notifications_inbox_changed AFTER INSERT OR UPDATE OR DELETE ON staff_notifications
  FOR EACH ROW EXECUTE FUNCTION notify_inbox_changed();
--> statement-breakpoint
-- A conversation lists the contact's upcoming bookings.
CREATE TRIGGER bookings_inbox_changed AFTER INSERT OR UPDATE OR DELETE ON bookings
  FOR EACH ROW EXECUTE FUNCTION notify_inbox_changed();
