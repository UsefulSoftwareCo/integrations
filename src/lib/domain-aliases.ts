/** Alias domain -> canonical domain. One vendor, one canonical bucket.
 * Canonical direction follows the vendor's own apex redirect
 * (e.g. sentry.dev 307s to sentry.io, vercel.sh 308s to vercel.com). */
export const DOMAIN_ALIASES: Record<string, string> = {
  "addressy.com": "loqate.com",
  "adyen.help": "adyen.com",
  "airbyte.io": "airbyte.com",
  "angular.io": "angular.dev",
  "apitoolkit.io": "monoscope.tech",
  "atlassian.net": "atlassian.com",
  "benevity.org": "benevity.com",
  "bigdatacloud.net": "bigdatacloud.com",
  "bit.ly": "bitly.com",
  "blueconic.net": "blueconic.com",
  "braze.eu": "braze.com",
  "bridgedb.github.io": "bridgedb.org",
  "bungie.com": "bungie.net",
  "cloud.sap": "sap.com",
  "contentstack.io": "contentstack.com",
  "convertkit.com": "kit.com",
  "dbt.com": "getdbt.com",
  "discord.gg": "discord.com",
  "docker.io": "docker.com",
  "eodhistoricaldata.com": "eodhd.com",
  "eventbriteapi.com": "eventbrite.com",
  "factset.io": "factset.com",
  "fathom.video": "fathom.ai",
  "fellow.app": "fellow.ai",
  "frontapp.com": "front.com",
  "getpinwheel.com": "pinwheelapi.com",
  "gist.githubusercontent.com": "github.com",
  "graphite.dev": "graphite.com",
  "heapanalytics.com": "heap.io",
  "helpscout.net": "helpscout.com",
  "hyperping.io": "hyperping.com",
  "ift.tt": "ifttt.com",
  "intercom.io": "intercom.com",
  "letsdeel.com": "deel.com",
  "logtail.com": "betterstack.com",
  "meetcampfire.com": "campfire.ai",
  "mermaidchart.com": "mermaid.ai",
  "neon.tech": "neon.com",
  "npmjs.org": "npmjs.com",
  "paystack.co": "paystack.com",
  "railway.app": "railway.com",
  "rfpio.com": "responsive.io",
  "rutterapi.com": "rutter.com",
  "sentry.dev": "sentry.io",
  "shippo.com": "goshippo.com",
  "signoz.cloud": "signoz.io",
  "snowplowanalytics.com": "snowplow.io",
  "storage.dev": "tigrisdata.com",
  "storecove.nl": "storecove.com",
  "swell.store": "swell.is",
  "t.me": "telegram.org",
  "tafkit.com": "tafqit.com",
  "thoughtspot.app": "thoughtspot.com",
  "timescale.com": "tigerdata.com",
  "tray.io": "tray.ai",
  "turso.ai": "turso.tech",
  "ur.com": "unitedrentals.com",
  "vercel.sh": "vercel.com",
  "zeit.co": "vercel.com",
  "zep.ai": "getzep.com",
  "zoho.com.au": "zoho.com",
  "zoho.jp": "zoho.com",
  "zoho.uk": "zoho.com",
  "zohomcp.eu": "zoho.com",
  "zohomcp.in": "zoho.com",
  "zoom.us": "zoom.com",
};

export function assertValidDomainAliases(aliases: Record<string, string>): void {
  for (const [alias, canonical] of Object.entries(aliases)) {
    const normalizedAlias = alias.toLowerCase().trim();
    const normalizedCanonical = canonical.toLowerCase().trim();
    if (!normalizedAlias || !normalizedCanonical) {
      throw new Error(`Invalid domain alias: ${alias} -> ${canonical}`);
    }
    if (normalizedAlias !== alias || normalizedCanonical !== canonical) {
      throw new Error(`Domain aliases must already be normalized: ${alias} -> ${canonical}`);
    }
    if (normalizedAlias === normalizedCanonical) {
      throw new Error(`Domain alias points to itself: ${alias}`);
    }
    if (aliases[normalizedCanonical]) {
      throw new Error(`Domain alias chain/cycle is not allowed: ${alias} -> ${canonical}`);
    }
  }
}

assertValidDomainAliases(DOMAIN_ALIASES);

export function canonicalDomain(domain: string): string {
  const d = domain.toLowerCase().trim();
  return DOMAIN_ALIASES[d] ?? d;
}

/** Canonical -> list of aliases (for redirects / KV fallback lookups). */
export function aliasesOf(canonical: string): string[] {
  const c = canonicalDomain(canonical);
  return Object.entries(DOMAIN_ALIASES)
    .filter(([, target]) => target === c)
    .map(([alias]) => alias)
    .sort();
}
