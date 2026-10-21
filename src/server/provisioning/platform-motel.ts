import { productionSql } from "@/server/db/production";

export type PlatformMotelInput = {
  name: string;
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  phone: string;
  timezone: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword?: string;
  planName: string;
  billingCycle: "monthly" | "quarterly" | "yearly" | "custom";
  amountCents: number;
  startsOn: string;
  expiresOn: string;
  status: "trial" | "active" | "past_due" | "suspended" | "cancelled";
  notes?: string;
};

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";

type PropertySettingsInput = Pick<PlatformMotelInput, "name" | "addressLine1" | "city" | "region" | "postalCode" | "phone" | "timezone" | "ownerName" | "ownerEmail">;

/**
 * A new property must receive its own complete settings document at provision
 * time. Without this record the web app falls back to its generic local
 * defaults, which makes a newly-created motel look like an unrelated demo.
 */
export function initialApplicationSettings(input: PropertySettingsInput, employeeId: string) {
  return {
    property: {
      name: input.name,
      addressLine1: input.addressLine1,
      city: input.city,
      state: input.region,
      postalCode: input.postalCode,
      phone: input.phone,
      email: input.ownerEmail,
      timezone: input.timezone,
      roomCount: 0,
      checkInTime: "3:00 PM",
      checkoutTime: "11:00 AM",
      nightAuditTime: "02:00",
      cashFloatCents: 20000,
      rulesAndRegulations: "Guest is responsible for room charges, damages, and compliance with property policies. Checkout is required by the posted checkout time.",
    },
    roomTypes: [
      { id: "room-type-queen", name: "Standard Queen", shortLabel: "1 Queen", bedDescription: "One queen bed", maxOccupancy: 2, baseRateCents: 10900, active: true },
      { id: "room-type-double", name: "Double Queen", shortLabel: "2 Queens", bedDescription: "Two queen beds", maxOccupancy: 4, baseRateCents: 11900, active: true },
      { id: "room-type-king", name: "Standard King", shortLabel: "1 King", bedDescription: "One king bed", maxOccupancy: 2, baseRateCents: 11900, active: true },
    ],
    reservationSources: ["Walk-In", "Phone Call", "OTA Reservation", "Stayover", "Other"],
    bookingChannels: [
      { id: "walk-in", name: "Walk-In", type: "Direct", commissionPercent: 0, active: true },
      { id: "phone", name: "Phone Call", type: "Direct", commissionPercent: 0, active: true },
      { id: "website", name: "Motel Website", type: "Direct", commissionPercent: 0, active: true },
      { id: "booking-com", name: "Booking.com", type: "OTA", commissionPercent: 15, active: true },
      { id: "expedia", name: "Expedia", type: "OTA", commissionPercent: 18, active: true },
      { id: "agoda", name: "Agoda", type: "OTA", commissionPercent: 17, active: true },
      { id: "oyo", name: "OYO", type: "OTA", commissionPercent: 15, active: true },
      { id: "stayover", name: "Stayover", type: "Direct", commissionPercent: 0, active: true },
      { id: "company", name: "Company Direct Bill", type: "Company", commissionPercent: 0, active: true },
    ],
    rateCodes: [
      { id: "rack", name: "RACK", rateAdjustmentPercent: 0, active: true },
      { id: "walk-in", name: "WALK-IN", rateAdjustmentPercent: 0, active: true },
      { id: "fixed", name: "FIXED GUEST RATE", rateAdjustmentPercent: 0, active: true },
      { id: "company", name: "COMPANY RATE", rateAdjustmentPercent: -10, active: true },
    ],
    promotions: [],
    paymentTypes: ["Cash", "Credit Card", "Debit Card", "Check", "Bank Transfer", "Direct Bill", "Other"],
    chargeTypes: ["Room Rent", "Pet Fee", "Early Check-In", "Late Checkout", "Miscellaneous Non-Taxable"],
    expenseCategories: ["Utilities", "Payroll", "Maintenance", "Supplies", "Laundry", "Office", "Repairs", "Taxes", "Insurance", "OTA Fees", "Other"],
    userRoles: ["Owner", "Manager", "Front Desk", "Accountant"],
    payrollFrequencies: ["Weekly", "Biweekly", "Semi-monthly"],
    payroll: { frequency: "Semi-monthly", periodLabel: "1st-15th and 16th-end of month", trackRoomsCleaned: true },
    invoice: { prefix: "INV", numberFormat: "INV-YYYY-####", nextInvoiceNumber: 1, defaultDueDays: 30 },
    tax: { percentage: 10, label: "Transient Occupancy Tax" },
    users: [{ id: employeeId, name: input.ownerName, role: "Owner", status: "Active" }],
  };
}

export function generateTemporaryPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function createOwnerAuthUser(input: PlatformMotelInput, password: string) {
  const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!baseUrl || !secret) throw new Error("Supabase administrator access is not configured.");
  const response = await fetch(`${baseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: secret, authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      email: input.ownerEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name: input.ownerName, motel_name: input.name },
    }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { msg?: string; message?: string };
    throw new Error(result.msg ?? result.message ?? "The owner account could not be created.");
  }
  const result = await response.json() as { id?: string; user?: { id?: string } };
  const id = result.id ?? result.user?.id;
  if (!id) throw new Error("The owner account did not return an ID.");
  return id;
}

async function deleteOwnerAuthUser(id: string) {
  const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (baseUrl && secret) await fetch(`${baseUrl}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: secret, authorization: `Bearer ${secret}` } });
}

export async function provisionPlatformMotel(input: PlatformMotelInput) {
  const temporaryPassword = input.ownerPassword ? null : generateTemporaryPassword();
  const ownerAuthUserId = await createOwnerAuthUser(input, input.ownerPassword ?? temporaryPassword!);
  const propertyId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const employeeId = crypto.randomUUID();
  const applicationSettings = initialApplicationSettings(input, employeeId);
  try {
    await productionSql().begin(async (tx) => {
      await tx`
        insert into properties (id,name,address_line_1,city,region,postal_code,phone,timezone,status)
        values (${propertyId}::uuid,${input.name},${input.addressLine1},${input.city},${input.region},${input.postalCode},${input.phone},${input.timezone},'active')
      `;
      await tx`
        insert into property_memberships (id,property_id,auth_user_id,role,active)
        values (${membershipId}::uuid,${propertyId}::uuid,${ownerAuthUserId}::uuid,'owner',true)
      `;
      await tx`
        insert into employees (id,property_id,membership_id,name,email,job_role,pay_method,active)
        values (${employeeId}::uuid,${propertyId}::uuid,${membershipId}::uuid,${input.ownerName},${input.ownerEmail},'Owner/Admin','hourly',true)
      `;
      await tx`
        insert into property_settings (property_id,key,value)
        values
          (${propertyId}::uuid,'currency','{"code":"USD","country":"US"}'::jsonb),
          (${propertyId}::uuid,'invoice','{"prefix":"FOL","nextNumber":1,"annualReset":false,"paymentTermsDays":30}'::jsonb),
          (${propertyId}::uuid,'tax','{"percentage":0}'::jsonb),
          (${propertyId}::uuid,'application_settings',${JSON.stringify(applicationSettings)}::jsonb)
      `;
      await tx`
        insert into platform_subscriptions (property_id,plan_name,billing_cycle,amount_cents,starts_on,expires_on,status,notes)
        values (${propertyId}::uuid,${input.planName},${input.billingCycle},${input.amountCents},${input.startsOn}::date,${input.expiresOn}::date,${input.status},${input.notes ?? null})
      `;
    });
  } catch (error) {
    await deleteOwnerAuthUser(ownerAuthUserId);
    throw error;
  }
  return { propertyId, ownerEmail: input.ownerEmail, temporaryPassword };
}
