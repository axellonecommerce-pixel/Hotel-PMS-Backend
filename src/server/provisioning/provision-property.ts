import { db } from "@/server/db/client";
import { employees, properties, propertyMemberships, propertySettings } from "@/server/db/schema";

export type ProvisionPropertyInput = {
  name: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  phone: string;
  timezone: string;
  ownerAuthUserId: string;
  ownerName: string;
};

export function provisionProperty(input: ProvisionPropertyInput) {
  const propertyId = `property-${crypto.randomUUID()}`;
  const membershipId = `membership-${crypto.randomUUID()}`;
  const employeeId = `employee-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  db.transaction((tx) => {
    tx.insert(properties).values({
      id: propertyId,
      name: input.name,
      addressLine1: input.addressLine1,
      city: input.city,
      state: input.state,
      postalCode: input.postalCode,
      phone: input.phone,
      timezone: input.timezone,
      roomCount: 0,
      checkInTime: "15:00",
      checkoutTime: "11:00",
      createdAt: now,
      updatedAt: now,
    }).run();
    tx.insert(propertyMemberships).values({
      id: membershipId,
      propertyId,
      authUserId: input.ownerAuthUserId,
      role: "owner",
      active: true,
      createdAt: now,
      updatedAt: now,
    }).run();
    tx.insert(employees).values({
      id: employeeId,
      propertyId,
      membershipId,
      name: input.ownerName,
      role: "Owner/Admin",
      status: "Active",
      hourlyRateCents: 0,
      createdAt: now,
      updatedAt: now,
    }).run();
    tx.insert(propertySettings).values([
      { id: `setting-${crypto.randomUUID()}`, propertyId, key: "currency", value: JSON.stringify({ code: "USD", country: "US" }), updatedAt: now },
      { id: `setting-${crypto.randomUUID()}`, propertyId, key: "invoice", value: JSON.stringify({ prefix: "FOL", nextNumber: 1, annualReset: false, paymentTermsDays: 30 }), updatedAt: now },
      { id: `setting-${crypto.randomUUID()}`, propertyId, key: "tax", value: JSON.stringify({ percentage: 0 }), updatedAt: now },
    ]).run();
  });
  return { propertyId, membershipId, employeeId };
}
