-- Foundations: extensions later migrations depend on.

-- btree_gist lets one GiST exclusion constraint combine equality on a uuid column with
-- overlap on a time range. The bookings double-booking guard (spec §6) needs it:
--   EXCLUDE USING gist (resource_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
-- It is a trusted extension, so a database owner can create it without superuser.
CREATE EXTENSION IF NOT EXISTS btree_gist;
