function storageConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.PMS_PRIVATE_BUCKET ?? "hotel-private";
  if (!url || !key) throw new Error("Private file storage is not configured.");
  return { url, key, bucket };
}

export async function uploadPrivateFile(storageKey: string, file: File) {
  const config = storageConfig();
  const response = await fetch(`${config.url}/storage/v1/object/${config.bucket}/${storageKey}`, {
    method: "POST", headers: { Authorization: `Bearer ${config.key}`, apikey: config.key, "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" }, body: file,
  });
  if (!response.ok) throw new Error("Private file upload failed.");
}

export async function signedPrivateFileUrl(storageKey: string) {
  const config = storageConfig();
  const response = await fetch(`${config.url}/storage/v1/object/sign/${config.bucket}/${storageKey}`, {
    method: "POST", headers: { Authorization: `Bearer ${config.key}`, apikey: config.key, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!response.ok) throw new Error("Private download link could not be created.");
  const data = await response.json() as { signedURL: string };
  return `${config.url}/storage/v1${data.signedURL}`;
}

export async function deletePrivateFiles(storageKeys: string[]) {
  if (!storageKeys.length) return;
  const config = storageConfig();
  const response = await fetch(`${config.url}/storage/v1/object/${config.bucket}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${config.key}`, apikey: config.key, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: storageKeys }),
  });
  if (!response.ok) throw new Error("Private files could not be deleted.");
}
