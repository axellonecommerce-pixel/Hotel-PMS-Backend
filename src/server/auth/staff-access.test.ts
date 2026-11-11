import { expect, test } from "bun:test";

import { effectiveAccess, hasPermission } from "./authorization";
import { accessLayers, cleanStaffAccess } from "./staff-access";

test("a login with the owner's own role gets that role's access, and only for the role it is based on", () => {
  const stored = cleanStaffAccess({
    customRoles: [{ id: "night1", name: "Night Auditor", basedOn: "front_desk", access: { permissions: ["night_audit.run", "reservations.manage"], reports: ["final-audit"] } }],
    assignments: { "user-1": "night1", "user-2": "missing" },
    roles: { front_desk: { permissions: ["guests.manage"] } },
  });
  const layers = accessLayers(stored, "user-1", "front_desk");
  expect(layers.custom?.name).toBe("Night Auditor");
  const access = effectiveAccess("front_desk", layers.override, layers.roleOverride);
  expect(hasPermission("front_desk", "night_audit.run", access)).toBe(true);
  expect(hasPermission("front_desk", "guests.manage", access)).toBe(false);
  // An assignment to a role that is gone is dropped; that login follows its built-in role.
  expect(stored.assignments["user-2"]).toBeUndefined();
  const plain = accessLayers(stored, "user-2", "front_desk");
  expect(hasPermission("front_desk", "guests.manage", effectiveAccess("front_desk", plain.override, plain.roleOverride))).toBe(true);
  // A stored role based on the owner is ignored.
  expect(cleanStaffAccess({ customRoles: [{ id: "x", name: "Boss", basedOn: "owner", access: {} }] }).customRoles).toHaveLength(0);
});
