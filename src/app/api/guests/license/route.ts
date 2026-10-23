import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/server/db/client";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { guests } from "@/server/db/schema";
import { hasProductionDatabase, productionSql } from "@/server/db/production";

type StoredAddress = {
  addressLine1?: string;
  postalCode?: string;
  city?: string;
  state?: string;
  country?: string;
  countryCode?: string;
};

function guestStatus(status: string) {
  return status === "do_not_rent" ? "Do Not Rent" : status === "returning" ? "Returning" : status === "regular" ? "Regular" : "New";
}

export async function GET(request: Request) {
  let session;
  try {
    session = await requirePropertySession(request, "guests.manage");
  } catch (error) {
    return propertyAccessResponse(error);
  }
  const { propertyId } = session;
  const license = new URL(request.url).searchParams.get("number")?.replace(/\s/g, "").toUpperCase();
  if (!license) return NextResponse.json({ error: "ID number is required." }, { status: 400 });
  if (hasProductionDatabase()) {
    const [guest] = await productionSql()<Array<{
      id: string; firstName: string; lastName: string; phone: string | null; email: string | null;
      address: StoredAddress | null; guestStatus: string; idType: string; idNumber: string;
    }>>`
      select g.id,g.first_name as "firstName",g.last_name as "lastName",g.phone,g.email,g.address,
        g.guest_status as "guestStatus",gi.id_type as "idType",gi.id_number as "idNumber"
      from guest_identities gi
      join guests g on g.id=gi.guest_id and g.property_id=gi.property_id
      where gi.property_id=${propertyId}::uuid and gi.normalized_id_number=${license} and gi.deleted_at is null
      order by gi.captured_at desc limit 1
    `;
    if (!guest) return NextResponse.json({ guest: null });
    const address = guest.address ?? {};
    return NextResponse.json({
      guest: {
        id: guest.id,
        firstName: guest.firstName,
        lastName: guest.lastName,
        phone: guest.phone ?? "",
        idType: guest.idType,
        idNumber: guest.idNumber,
        addressLine1: address.addressLine1 ?? "",
        postalCode: address.postalCode ?? "",
        city: address.city ?? "",
        state: address.state ?? "",
        country: address.country ?? "United States",
        countryCode: address.countryCode ?? "+1",
        email: guest.email ?? "",
        status: guestStatus(guest.guestStatus),
      },
    });
  }
  const guest = await db.query.guests.findFirst({
    where: and(eq(guests.propertyId, propertyId), eq(guests.driverLicenseNormalized, license)),
  });
  if (!guest) return NextResponse.json({ guest: null });
  return NextResponse.json({
    guest: {
      id: guest.id,
      firstName: guest.firstName,
      lastName: guest.lastName,
      phone: guest.phone,
      idType: guest.idType,
      idNumber: guest.driverLicenseNumber,
      dateOfBirth: guest.dateOfBirth,
      idExpires: guest.idExpires,
      addressLine1: guest.addressLine1,
      postalCode: guest.postalCode,
      city: guest.city,
      state: guest.state,
      country: guest.country,
      countryCode: guest.countryCode,
      secondaryPhone: guest.secondaryPhone,
      email: guest.email,
      secondaryEmail: guest.secondaryEmail,
      status: guest.guestStatus,
    },
  });
}
