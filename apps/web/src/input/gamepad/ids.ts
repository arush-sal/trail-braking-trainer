export type VidPid = { vid: string; pid: string };

/** Chrome: "... Vendor: 046d Product: c266"; Firefox: "046d-c266-Name". Safari may omit both -> null. */
export function parseVidPid(id: string): VidPid | null {
  const c = /Vendor:\s*([0-9a-f]{4})\s+Product:\s*([0-9a-f]{4})/i.exec(id);
  const f = /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(id);
  const m = c ?? f;
  return m ? { vid: m[1]!.toLowerCase(), pid: m[2]!.toLowerCase() } : null;
}
