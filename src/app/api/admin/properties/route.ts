import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { provisionProperty } from "@/server/provisioning/provision-property";

const inputSchema = z.object({
  name: z.string().trim().min(1),
  addressLine1: z.string().trim().min(1),
  city: z.string().trim().min(1),
  state: z.string().trim().min(1),
  postalCode: z.string().trim().min(1),
  phone: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
  ownerAuthUserId: z.string().trim().min(1),
  ownerName: z.string().trim().min(1),
});

function validProvisioningKey(request: Request) {
  const expected = process.env.PMS_PROVISIONING_KEY;
  const supplied = request.headers.get("x-pms-provisioning-key");
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export async function POST(request: Request) {
  if (!validProvisioningKey(request)) return Response.json({ error: "Invalid provisioning credentials." }, { status: 401 });
  const parsed = inputSchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: "Hotel and owner details are required.", issues: parsed.error.flatten() }, { status: 400 });
  try {
    return Response.json(provisionProperty(parsed.data), { status: 201 });
  } catch (error) {
    const message = error instanceof Error && error.message.includes("UNIQUE")
      ? "That owner is already linked to this hotel."
      : "The hotel could not be provisioned.";
    return Response.json({ error: message }, { status: 409 });
  }
}
