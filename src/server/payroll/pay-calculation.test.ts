import { describe, expect, it } from "bun:test";

import { grossPayCents, payForPeriod, salaryForPeriod, splitWorkedMinutes, stateCode, workweekBounds } from "./pay-calculation";

const nineHourDays = (dates: string[]) => dates.map((date) => ({ date, minutes: 9 * 60 }));

describe("payroll overtime by state", () => {
  it("pays California daily overtime after 8 hours and double time after 12", () => {
    const split = splitWorkedMinutes([{ date: "2026-10-20", minutes: 13 * 60 }], "2026-10-16", "2026-10-31", "California");
    expect(split).toEqual({ regularMinutes: 480, overtimeMinutes: 240, doubleTimeMinutes: 60 });
    expect(grossPayCents(split, 2000)).toBe(16000 + 12000 + 4000);
  });

  it("uses only the weekly 40-hour rule in Texas", () => {
    expect(splitWorkedMinutes([{ date: "2026-10-20", minutes: 13 * 60 }], "2026-10-16", "2026-10-31", "TX")).toEqual({ regularMinutes: 780, overtimeMinutes: 0, doubleTimeMinutes: 0 });
  });

  it("counts the whole Monday-to-Sunday week when a pay period starts mid-week", () => {
    const days = nineHourDays(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-18"]);
    expect(splitWorkedMinutes(days, "2026-10-16", "2026-10-31", "CA")).toEqual({ regularMinutes: 480, overtimeMinutes: 600, doubleTimeMinutes: 0 });
    expect(splitWorkedMinutes(days, "2026-10-16", "2026-10-31", "TX")).toEqual({ regularMinutes: 240, overtimeMinutes: 840, doubleTimeMinutes: 0 });
    expect(workweekBounds("2026-10-16", "2026-10-31")).toEqual({ from: "2026-10-12", to: "2026-11-01" });
  });

  it("reads state names and codes", () => {
    expect(stateCode("california")).toBe("CA");
    expect(stateCode("tx")).toBe("TX");
    expect(stateCode("Ontario")).toBe("");
  });
});

describe("pay increases", () => {
  const employee = { payType: "hourly", hourlyRateCents: 1800, salaryCents: null };
  const changes = [{ effectiveDate: "2026-11-01", payType: "hourly", fromHourlyCents: 1500, toHourlyCents: 1800 }];
  it("uses the old rate until the first pay period starting on or after the increase", () => {
    expect(payForPeriod(employee, changes, "2026-10-26").hourly).toBe(1500);
    expect(payForPeriod(employee, changes, "2026-11-02").hourly).toBe(1800);
    expect(payForPeriod(employee, undefined, "2026-10-26").hourly).toBe(1800);
  });
});

describe("salary for a back-dated start", () => {
  it("pays the full salary once employed for the whole period", () => {
    expect(salaryForPeriod(230000, "2026-10-05", "2026-10-11", "2026-09-01")).toBe(230000);
    expect(salaryForPeriod(230000, "2026-10-05", "2026-10-11")).toBe(230000);
  });
  it("pays the days from the start date in the first period and nothing before it", () => {
    expect(salaryForPeriod(70000, "2026-10-05", "2026-10-11", "2026-10-09")).toBe(30000);
    expect(salaryForPeriod(70000, "2026-10-05", "2026-10-11", "2026-10-12")).toBe(0);
  });
});

describe("workweek start day", () => {
  it("runs Friday to Thursday when the week starts on Friday", () => {
    expect(workweekBounds("2026-10-24", "2026-10-29", 5)).toEqual({ from: "2026-10-23", to: "2026-10-29" });
    expect(workweekBounds("2026-10-24", "2026-10-29")).toEqual({ from: "2026-10-19", to: "2026-11-01" });
  });
  it("counts weekly overtime within the Friday workweek", () => {
    // 4 × 11h Fri–Mon in Texas (weekly only): 44h in one Friday week; split across two Monday weeks.
    const days = ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"].map((date) => ({ date, minutes: 11 * 60 }));
    expect(splitWorkedMinutes(days, "2026-10-23", "2026-10-29", "Texas", 5).overtimeMinutes).toBe(240);
    expect(splitWorkedMinutes(days, "2026-10-23", "2026-10-29", "Texas").overtimeMinutes).toBe(0);
  });
});
