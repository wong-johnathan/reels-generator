/** Public original-object link only; resized variants remain on the web proxy. */
export function publicAssetUrl(objectKey: string): string | null {
  const endpoint = process.env.MINIO_PUBLIC_ENDPOINT?.trim();
  if (!endpoint) return null;
  // Startup validates MINIO_BUCKET; never substitute a guessed bucket.
  const bucket = process.env.MINIO_BUCKET;
  if (!bucket) return null;
  const url = new URL(endpoint);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  const base = url.pathname.split('/').filter(Boolean);
  const segments = [bucket, ...objectKey.split('/').filter(Boolean)].map(encodeURIComponent);
  url.pathname = '/' + [...base, ...segments].join('/');
  return url.toString();
}
