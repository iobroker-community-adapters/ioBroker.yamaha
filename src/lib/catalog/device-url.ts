// The cover addresses every transport shows — MusicCast and XML report covers the same way (a path on the device's own
// web server, one fixed path whose content changes). They lived in the MusicCast write mapper, so XML imported
// another transport's module for them (review 2026-10-05, X11).

/**
 * The address a device-relative path is fetched at: YXC answers the cover as a path on its own web
 * server ("If xxx/yyy/zzz.jpg is returned, the absolute path is http://{host}/xxx/yyy/zzz.jpg", YXC
 * Basic §7.2). A full URL (a service's own cover in the recently-played list) and "" stay as they
 * are; without a host nothing is invented (audit 2026-09-24, C6).
 *
 * @param url the address the device reported
 * @param host the device's address, as configured
 * @returns the address a browser or a visualisation can load
 */
export function absoluteDeviceUrl(url: string, host: string | undefined): string {
  if (url === "" || host === undefined || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return url;
  }
  return `http://${host}/${url.replace(/^\/+/, "")}`;
}

/**
 * A cover address that changes when the cover does. Several devices serve every cover under ONE fixed
 * path (`/YamahaRemoteControl/AlbumART/AlbumART.jpg`, YXC Basic Rev 1.10 §7.2) and say "the album art
 * changed" only by a new `albumart_id` — the datapoint stayed byte-identical and a widget kept showing the
 * previous track's cover (audit 2026-09-29, C36). The id rides along as a query, so the address changes.
 *
 * @param url the cover address ("" = none)
 * @param id the reported `albumart_id`
 * @returns the address, with the id appended where there is one
 */
export function withAlbumArtId(url: string, id: unknown): string {
  if (url === "" || (typeof id !== "number" && typeof id !== "string") || `${id}` === "") {
    return url;
  }
  return `${url}${url.includes("?") ? "&" : "?"}id=${encodeURIComponent(`${id}`)}`;
}
