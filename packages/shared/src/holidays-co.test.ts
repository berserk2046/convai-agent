import { describe, expect, it } from "vitest";
import {
  COLOMBIAN_HOLIDAYS,
  colombianHolidays,
  easterSunday,
  holidayOn,
  holidaysBetween,
} from "./holidays-co.ts";

const dates = (year: number) => colombianHolidays(year).map((h) => h.date);

describe("colombianHolidays", () => {
  // Published 2026 calendar (Ley 51 de 1983 moves applied), plus Ley 2578 de 2026's
  // Chiquinquirá holiday, which the Ministerio del Interior set for Monday 2026-07-13.
  it("matches the published 2026 calendar (19 days)", () => {
    expect(dates(2026)).toEqual([
      "2026-01-01",
      "2026-01-12",
      "2026-03-23",
      "2026-04-02",
      "2026-04-03",
      "2026-05-01",
      "2026-05-18",
      "2026-06-08",
      "2026-06-15",
      "2026-06-29",
      "2026-07-13",
      "2026-07-20",
      "2026-08-07",
      "2026-08-17",
      "2026-10-12",
      "2026-11-02",
      "2026-11-16",
      "2026-12-08",
      "2026-12-25",
    ]);
  });

  it("matches the published 2027 calendar", () => {
    expect(dates(2027)).toEqual([
      "2027-01-01",
      "2027-01-11",
      "2027-03-22",
      "2027-03-25",
      "2027-03-26",
      "2027-05-01",
      "2027-05-10",
      "2027-05-31",
      "2027-06-07",
      "2027-07-05",
      "2027-07-12",
      "2027-07-20",
      "2027-08-07",
      "2027-08-16",
      "2027-10-18",
      "2027-11-01",
      "2027-11-15",
      "2027-12-08",
      "2027-12-25",
    ]);
  });

  it("only counts Chiquinquirá from 2026 (Ley 2578 de 2026)", () => {
    expect(colombianHolidays(2025)).toHaveLength(18);
    expect(colombianHolidays(2025).some((h) => h.key === "virgen_de_chiquinquira")).toBe(false);
  });

  it("keeps fixed holidays on their date, whatever the weekday", () => {
    const fixed = colombianHolidays(2027).filter((h) =>
      ["dia_del_trabajo", "batalla_de_boyaca", "navidad"].includes(h.key),
    );
    expect(fixed.map((h) => h.date)).toEqual(["2027-05-01", "2027-08-07", "2027-12-25"]); // Saturdays
  });

  it("lets two holidays share a Monday", () => {
    const shared = colombianHolidays(2038).filter((h) => h.date === "2038-07-05");
    expect(shared.map((h) => h.key).sort()).toEqual(["sagrado_corazon", "san_pedro_y_san_pablo"]);
    expect(holidayOn("2038-07-05")?.name).toBe("Sagrado Corazón y San Pedro y San Pablo");
  });
});

describe("easterSunday", () => {
  it.each([
    [2024, "2024-03-31"],
    [2025, "2025-04-20"],
    [2026, "2026-04-05"],
    [2027, "2027-03-28"],
    [2038, "2038-04-25"],
  ])("%i → %s", (year, expected) => {
    expect(easterSunday(year).toISODate()).toBe(expected);
  });
});

describe("holidaysBetween", () => {
  it("is inclusive and crosses years", () => {
    expect(holidaysBetween("2026-12-25", "2027-01-11").map((h) => h.date)).toEqual([
      "2026-12-25",
      "2027-01-01",
      "2027-01-11",
    ]);
  });

  it("returns nothing for a normal week or a bad range", () => {
    expect(holidaysBetween("2026-10-05", "2026-10-11")).toEqual([]);
    expect(holidaysBetween("not-a-date", "2026-10-11")).toEqual([]);
  });
});

describe("holidayOn", () => {
  it("names a holiday and returns null otherwise", () => {
    expect(holidayOn("2026-11-02")).toEqual({
      name: "Todos los Santos",
      keys: ["todos_los_santos"],
      open: false,
    });
    expect(holidayOn("2026-11-01")).toBeNull();
  });

  it("is open every year the business chose to open on that holiday", () => {
    for (const date of ["2026-03-23", "2027-03-22", "2028-03-20"]) {
      expect(holidayOn(date, ["san_jose"])?.open).toBe(true);
    }
    expect(holidayOn("2026-04-02", ["san_jose"])?.open).toBe(false); // Jueves Santo
  });

  it("keeps a shared day closed unless both holidays are open", () => {
    expect(holidayOn("2038-07-05", ["san_pedro_y_san_pablo"])?.open).toBe(false);
    expect(holidayOn("2038-07-05", ["san_pedro_y_san_pablo", "sagrado_corazon"])?.open).toBe(true);
  });

  it("lists the 19 holidays the admin can switch on and off", () => {
    expect(COLOMBIAN_HOLIDAYS).toHaveLength(19);
    expect(COLOMBIAN_HOLIDAYS[0]).toEqual({ key: "ano_nuevo", name: "Año Nuevo" });
  });
});
