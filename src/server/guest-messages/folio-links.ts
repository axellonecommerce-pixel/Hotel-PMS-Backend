import { createHash } from "node:crypto";

/** Folio links are stored as a hash of their code, never the code itself. */
export const hashFolioToken = (token: string) => createHash("sha256").update(token).digest("hex");
