import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/server/db/client";
import { propertyAccessResponse, requirePropertySession } from "@/server/auth/property-session";
import { guests } from "@/server/db/schema";

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
