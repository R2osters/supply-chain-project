/** Links to pages whose target is chosen at runtime. Query strings, because the app is a static export. */
export function shipmentHref(id: string): string {
  return `/shipments/detail?id=${encodeURIComponent(id)}`;
}
