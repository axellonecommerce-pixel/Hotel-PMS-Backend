import { describe, expect, test } from "bun:test";

import { hasPermission } from "./authorization";
import { tokenAssuranceLevel } from "./jwt";

const token = (claims: Record<string, unknown>) =>
  `${Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

describe("payment deletion and guest download permissions", () => {
  test("owner has both", () => {
    expect(hasPermission("owner", "payments.delete")).toBe(true);
    expect(hasPermission("owner", "guests.export")).toBe(true);
  });
  test("manager may delete payments but not download every guest", () => {
    expect(hasPermission("manager", "payments.delete")).toBe(true);
    expect(hasPermission("manager", "guests.export")).toBe(false);
  });
  test("front desk, accountant and housekeeper have neither by default", () => {
    for (const role of ["front_desk", "accountant", "housekeeping"] as const) {
      expect(hasPermission(role, "payments.delete")).toBe(false);
      expect(hasPermission(role, "guests.export")).toBe(false);
    }
  });
  test("the owner can give a front desk login payment deletion", () => {
    expect(hasPermission("front_desk", "payments.delete", { permissions: new Set(["payments.delete"]), reports: [], settings: [] } as never)).toBe(true);
  });
});

describe("two-step sign-in level", () => {
  test("reads aal2 and aal1", () => {
    expect(tokenAssuranceLevel(token({ aal: "aal2" }))).toBe("aal2");
    expect(tokenAssuranceLevel(token({ aal: "aal1" }))).toBe("aal1");
  });
  test("anything else is not two-step", () => {
    expect(tokenAssuranceLevel(token({}))).toBeNull();
    expect(tokenAssuranceLevel("not-a-token")).toBeNull();
  });
});

describe("backups and the database connection", () => {
  test("only the owner restores backups by default", () => {
    expect(hasPermission("owner", "backups.manage")).toBe(true);
    for (const role of ["manager", "front_desk", "accountant", "housekeeping"] as const) expect(hasPermission(role, "backups.manage")).toBe(false);
  });
  test("every database but this computer's is reached over TLS", async () => {
    const { databaseNeedsTls } = await import("@/server/db/tls");
    expect(databaseNeedsTls("postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres")).toBe(true);
    expect(databaseNeedsTls("postgres://postgres@localhost:54329/t")).toBe(false);
    expect(databaseNeedsTls("not a url")).toBe(true);
  });
});
