// GitHub star count for the nav badge, resolved once per process and cached.
//
// Two contexts call this:
//  - build-time prerender: no worker env — fetch the GitHub API directly
//    (one call per build, module-cached).
//  - worker SSR: read the baked /disc/meta.json through the ASSETS binding
//    (written at build from the same GitHub fetch), so runtime pages show the
//    same number as the prerendered ones without touching the GitHub API.

const REPO = "UsefulSoftwareCo/integrationsdotsh";
export const REPO_URL = `https://github.com/${REPO}`;

interface AssetsFetcher {
  fetch: (request: Request | string) => Promise<Response>;
}

let cached: Promise<number | null> | undefined;

async function fromGitHub(): Promise<number | null> {
  if (process.env.INTEGRATIONS_FETCH_GITHUB_STARS !== "1") return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers: { "User-Agent": "integrations.sh-build", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

async function fromAssets(assets: AssetsFetcher): Promise<number | null> {
  try {
    const res = await assets.fetch("https://assets.local/disc/meta.json");
    if (!res.ok) return null;
    const meta = (await res.json()) as { stars?: number | null };
    return typeof meta.stars === "number" ? meta.stars : null;
  } catch {
    return null;
  }
}

export function getStars(env?: { ASSETS?: AssetsFetcher }): Promise<number | null> {
  cached ??= env?.ASSETS ? fromAssets(env.ASSETS) : fromGitHub();
  return cached;
}
