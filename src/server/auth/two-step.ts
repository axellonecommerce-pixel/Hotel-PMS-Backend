import { hasProductionDatabase, productionSql } from "@/server/db/production";
import { tokenAssuranceLevel, twoStepRequired } from "./jwt";

/**
 * Two-step sign-in is optional: each person turns it on for their own login
 * (account menu › Two-step sign-in). Once it is on, every request from that
 * login must come from a sign-in that entered the authenticator code
 * ("aal2"), so a stolen password alone is not enough.
 */
export async function hasTwoStepOn(authUserId: string) {
  if (!hasProductionDatabase() || !/^[0-9a-f-]{36}$/i.test(authUserId)) return false;
  try {
    const [row] = await productionSql()<Array<{ on: boolean }>>`
      select exists(select 1 from auth.mfa_factors where user_id=${authUserId}::uuid and status='verified') as on
    `;
    return Boolean(row?.on);
  } catch {
    // No auth schema (a local test database): nothing to enforce.
    return false;
  }
}

/** True when this login has two-step on but the request's sign-in skipped the code. */
export async function missingSecondStep(authUserId: string, token: string) {
  if (!twoStepRequired() || tokenAssuranceLevel(token) === "aal2") return false;
  return hasTwoStepOn(authUserId);
}
