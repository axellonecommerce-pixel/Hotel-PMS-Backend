/** Every database except one on this computer (local tests) is reached over TLS. */
export function databaseNeedsTls(connectionString: string) {
  try {
    const host = new URL(connectionString.replace(/^postgres(ql)?:/, "http:")).hostname;
    return !["localhost", "127.0.0.1", "::1", ""].includes(host);
  } catch {
    return true;
  }
}
