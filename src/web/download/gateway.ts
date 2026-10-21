/**
 * S-15 download — the data dependency that resolves a project's final rendered
 * video and reads its bytes out of object storage.
 *
 * The web app renders what this gateway returns and never invents a response:
 * `download` returns `null` when the project has no rendered-video asset (the
 * route answers 404), and the gateway is simply absent when no object store is
 * bound (the route answers 503).
 */
export interface VideoDownloadFile {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  /** The Content-Disposition filename — already slugged, never a raw DB value. */
  readonly filename: string;
}

export interface VideoDownloadGateway {
  /**
   * Resolve the newest RE video asset for the project and read its object.
   * `null` means "no rendered video to download", not "storage failed".
   */
  download(videoId: string): Promise<VideoDownloadFile | null>;
}
