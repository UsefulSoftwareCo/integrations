// A client SDK / library is NOT a CLI. Before the discovery prompt was
// tightened, the agent filed import-me packages (an npm/pip client, a
// "<Product> JavaScript/TypeScript SDK") under `cli`, because that was the
// closest of the four surface types (http | graphql | mcp | cli). This
// predicate identifies those mis-typed surfaces so the display + catalog paths
// can drop them from the CLI section.
//
// The check is deliberately NAME-driven. The `command` field is not a reliable
// discriminator: the agent routinely emitted runtimes (`python`, `node`,
// `npx`), the bare package name (`benchling`, `galileo`), or even code calls
// (`Rutter.create`) as the "command" of an SDK. So we ignore `command` and give
// the benefit of the doubt only when the name itself explicitly says CLI.

const SDK_NAME =
  /\bsdks?\b|\bclient librar(?:y|ies)\b|\b(?:npm|pypi|pip|gem|composer|nuget|maven|packagist)\s+package\b|\b(?:node(?:\.?js)?|javascript|typescript|python|ruby|php|java|kotlin|swift|go(?:lang)?|\.net|dotnet|rust|android|ios|react[-\s]?native)\s+(?:sdk|client|library|package)\b/i;

// If the name itself calls it a CLI / command-line tool, keep it — it is either
// a genuine command-line executable or a dual SDK+CLI where the CLI is real.
const EXPLICIT_CLI = /\bclis?\b|command[-\s]?line/i;

/** True when a `cli`-typed surface is really a client SDK/library, not a
 *  command-line executable. Shared by the live render path (buildSections) and
 *  the static catalog build (buildDiscovered) so both classify identically. */
export function isSdkNotCli(surface: { type?: string; name?: string }): boolean {
  if (surface.type !== "cli") return false;
  const name = surface.name ?? "";
  if (!SDK_NAME.test(name)) return false;
  return !EXPLICIT_CLI.test(name);
}
