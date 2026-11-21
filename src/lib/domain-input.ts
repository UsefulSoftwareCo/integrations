/** Extract the hostname from a URL pasted into a domain route. */
export function domainFromUrlPath(pathname: string): string | null {
  const match = /^\/(https?):\/\/([^/]+)(?:\/.*)?$/i.exec(pathname);
  if (!match) return null;

  try {
    return new URL(`${match[1]}://${match[2]}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}
