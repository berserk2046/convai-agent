import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.ts";

const tz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * People who log into the admin (spec §6, §12). Platform-level: no business_id and no
 * tenant grants, so tenant transactions can't see them at all.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stored lowercased and trimmed; unique. */
    email: text("email").notNull(),
    name: text("name").notNull(),
    /** argon2id, PHC string format (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`). */
    passwordHash: text("password_hash").notNull(),
    isPlatformOwner: boolean("is_platform_owner").notNull().default(false),
    /** Deactivated users can't log in; their sessions stop working. */
    active: boolean("active").notNull().default(true),
    createdAt: tz("created_at").notNull().defaultNow(),
    lastLoginAt: tz("last_login_at"),
  },
  (t) => [unique("users_email_key").on(t.email)],
);

export const MEMBERSHIP_ROLES = ["business_admin", "business_staff"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/** Which businesses a user works for, and as what. */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    role: text("role", { enum: MEMBERSHIP_ROLES }).notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("memberships_user_business_key").on(t.userId, t.businessId),
    check("memberships_role_check", sql`${t.role} in ('business_admin', 'business_staff')`),
  ],
);

/**
 * Login sessions (spec §12: httpOnly session cookies). The cookie holds a random token;
 * only its HMAC is stored, so a database leak doesn't hand out sessions. `business_id` is
 * the business the session works in (one of the user's memberships, or a business the
 * platform owner impersonates): business screens take it from here, never from the URL.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    businessId: uuid("business_id").references(() => businesses.id),
    impersonating: boolean("impersonating").notNull().default(false),
    createdAt: tz("created_at").notNull().defaultNow(),
    expiresAt: tz("expires_at").notNull(),
    lastSeenAt: tz("last_seen_at").notNull().defaultNow(),
  },
  (t) => [
    unique("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
  ],
);

/** Login attempts, for rate limiting (spec §13). Platform-level. */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    ip: text("ip"),
    succeeded: boolean("succeeded").notNull(),
    at: tz("at").notNull().defaultNow(),
  },
  (t) => [
    index("login_attempts_email_at_idx").on(t.email, t.at),
    index("login_attempts_ip_at_idx").on(t.ip, t.at),
  ],
);

/**
 * Who changed what (spec §13): config changes, template publishes, staff actions,
 * impersonation. Business rows are written inside the change's own tenant transaction;
 * platform rows (business_id null) by platform-owner actions.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    businessId: uuid("business_id").references(() => businesses.id),
    action: text("action").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    at: tz("at").notNull().defaultNow(),
  },
  (t) => [index("audit_log_business_at_idx").on(t.businessId, t.at)],
);

export type UserRow = typeof users.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
