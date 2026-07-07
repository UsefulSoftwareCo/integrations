/** Alias domain -> canonical domain. One vendor, one canonical bucket.
 * Canonical direction follows the vendor's own apex redirect
 * (e.g. sentry.dev 307s to sentry.io, vercel.sh 308s to vercel.com). */
export const DOMAIN_ALIASES: Record<string, string> = {
  "ably.io": "ably.com",
  "ably.net": "ably.com",
  "addressy.com": "loqate.com",
  "adobe.io": "adobe.com",
  "adyen.help": "adyen.com",
  "airbyte.io": "airbyte.com",
  "alpic.live": "alpic.ai",
  "amentum.space": "amentum.io",
  "angular.io": "angular.dev",
  "apidocumentation.com": "scalar.com",
  "apitoolkit.io": "monoscope.tech",
  "atlassian.net": "atlassian.com",
  "auraintel.com": "getaura.ai",
  "auraintelligence.com": "getaura.ai",
  "avatars1.githubusercontent.com": "github.com",
  "bclaws.ca": "gov.bc.ca",
  "benevity.org": "benevity.com",
  "bigdatacloud.net": "bigdatacloud.com",
  "bit.ly": "bitly.com",
  "blueconic.net": "blueconic.com",
  "braze.eu": "braze.com",
  "bridgedb.github.io": "bridgedb.org",
  "bufferapp.com": "buffer.com",
  "bungie.com": "bungie.net",
  "cloud.sap": "sap.com",
  "contentstack.io": "contentstack.com",
  "convertkit.com": "kit.com",
  "dbt.com": "getdbt.com",
  "discord.gg": "discord.com",
  "docker.io": "docker.com",
  "domotz.app": "domotz.com",
  "eodhistoricaldata.com": "eodhd.com",
  "ethoslife.com": "ethos.com",
  "eventbriteapi.com": "eventbrite.com",
  "factset.io": "factset.com",
  "fastmcp.cloud": "prefect.io",
  "fathom.video": "fathom.ai",
  "fellow.app": "fellow.ai",
  "formapi.io": "docspring.com",
  "frontapp.com": "front.com",
  "getmiso.com": "miso.kr",
  "getpinwheel.com": "pinwheelapi.com",
  "gist.githubusercontent.com": "github.com",
  "gitea.io": "gitea.com",
  "graphite.dev": "graphite.com",
  "heapanalytics.com": "heap.io",
  "hellosign.com": "dropbox.com",
  "helpscout.net": "helpscout.com",
  "hyperping.io": "hyperping.com",
  "ift.tt": "ifttt.com",
  "intercom.io": "intercom.com",
  "letsdeel.com": "deel.com",
  "logtail.com": "betterstack.com",
  "mashape.com": "konghq.com",
  "mdsol.com": "medidata.com",
  "meetcampfire.com": "campfire.ai",
  "mermaidchart.com": "mermaid.ai",
  "motos.net": "coches.net",
  "neon.tech": "neon.com",
  "nexmo.com": "vonage.com",
  "nfusionsolutions.biz": "nfusionsolutions.com",
  "npmjs.org": "npmjs.com",
  "paystack.co": "paystack.com",
  "polygon.io": "massive.com",
  "pscale.dev": "planetscale.com",
  "railway.app": "railway.com",
  "readme.io": "readme.com",
  "rfpio.com": "responsive.io",
  "rumble.run": "runzero.com",
  "rutterapi.com": "rutter.com",
  "sentry.dev": "sentry.io",
  "shippo.com": "goshippo.com",
  "signoz.cloud": "signoz.io",
  "sitejabber.com": "smartcustomer.com",
  "snowplowanalytics.com": "snowplow.io",
  "storage.dev": "tigrisdata.com",
  "storecove.nl": "storecove.com",
  "strivemaths.com": "strivemath.com",
  "swell.store": "swell.is",
  "t.me": "telegram.org",
  "tafkit.com": "tafqit.com",
  "thoughtspot.app": "thoughtspot.com",
  "timescale.com": "tigerdata.com",
  "tray.io": "tray.ai",
  "turso.ai": "turso.tech",
  "twitter.com": "x.com",
  "ur.com": "unitedrentals.com",
  "vercel.sh": "vercel.com",
  "watchful.li": "watchful.net",
  "zeit.co": "vercel.com",
  "zep.ai": "getzep.com",
  "zoho.com.au": "zoho.com",
  "zoho.eu": "zoho.com",
  "zoho.in": "zoho.com",
  "zoho.jp": "zoho.com",
  "zoho.sa": "zoho.com",
  "zoho.uk": "zoho.com",
  "zohocloud.ca": "zoho.com",
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
