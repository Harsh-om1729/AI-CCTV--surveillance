/** Hides a credential embedded in an rtsp://user:pass@host URL wherever it
 * would otherwise be displayed (camera lists, tooltips). The raw source
 * still goes to the backend on save/test — only on-screen display is masked,
 * since the dashboard has no reason to show a password back to a viewer. */
export function maskRtspUrl(source: string | number | undefined | null): string {
  if (source == null) return '';
  const str = String(source);
  return str.replace(/(rtsp|http|https):\/\/([^:@/]+):([^@/]+)@/i, '$1://$2:••••@');
}
