# 0009 — Built-in Colombian public holidays

Status: accepted (M3 follow-up, spec review C2)

## Sources

- **Ley 51 de 1983 (Ley Emiliani), art. 1.** It lists the holidays and which of them move
  to the next Monday when they don't fall on one.
- **Ley 2347 de 2024.** October 12 is the "Día de la Diversidad Étnica y Cultural".
- **Ley 2578 de 2026, art. 6** (Diario Oficial 53.510; in force since its promulgation on
  2026-06-01). It adds July 9, Nuestra Señora del Rosario de Chiquinquirá, also moved under
  Ley 51. The Ministerio del Interior set the 2026 day off on Monday July 13.
- The tests check the computed 2026 and 2027 lists against published calendars.

## Decision

1. **Computed in code** (`@platform/shared`, `holidays-co.ts`). There are 19 rules:
   - 6 fixed dates that never move;
   - 8 fixed dates that move to Monday;
   - 5 relative to Easter: Jueves and Viernes Santo stay put; Ascensión, Corpus Christi
     and Sagrado Corazón move to Monday.

   Easter uses the anonymous Gregorian algorithm. A rule can carry a first year
   (`since`), so Chiquinquirá counts from 2026 on. Two holidays can land on the same
   Monday (2038-07-05); the day then reads "Sagrado Corazón y San Pedro y San Pablo".

2. **Closed by default.** `findCandidates` skips `closedDates` (local dates). The agent's
   slot search passes every holiday in the window that the business hasn't opened, so
   `check_availability`, `book` and `reschedule` never use those days.
3. **The per-business choice is `businesses.holidays.open_holidays`**, a jsonb platform
   setting like `limits`, because every vertical needs it.
   - It holds holiday keys ("san_jose"), not dates, so a choice holds every year until the
     business switches it off (owner's decision, 2026-10-08). The admin lists
     `COLOMBIAN_HOLIDAYS` with an on/off switch each (`setHolidayOpen`).
   - On a holiday it opens, the business keeps that weekday's usual hours. Closures still
     apply on top, e.g. for one year's exception.
   - A day two holidays share (2038-07-05) stays closed unless both are open: wrongly
     closed loses a booking, while wrongly open sends a patient to a locked door.
   - Every key must be a known holiday (`updateBusinessHolidays`, `createBusiness`). Keys
     are stored sorted, without repeats.
4. **The agent knows.**
   - `now.calendar[].holiday` is `{ name, open }` or null, and odontologia renders it as
     "(festivo: …, cerrado)".
   - `check_availability` lists `closed_holidays` in the requested range. That covers
     dates beyond the 14-day calendar.
   - Template validation exercises the holiday fields, because the sample clock's
     calendar includes 2026-10-12.

## Consequences

- Existing businesses are closed on holidays from now on, unless they open them.
- A new or changed holiday law means a new rule in `holidays-co.ts`, plus a test with the
  published dates.
- A business that opens on every holiday (restaurants, M9) switches all 19 on once. An
  "open on all holidays" shortcut can be added without breaking anything.
- Holidays are Colombian only. A `country` setting can come with the first business
  outside Colombia.
