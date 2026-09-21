/**
 * Argument parsing and the repo root, with no other dependencies.
 *
 * WHY THIS IS SEPARATE FROM shared.ts. `shared.ts` pulls in the discovery
 * runtime (discover.ts → catalog-seed.ts), and catalog-seed.ts *statically*
 * imports `output/catalog-seeds.json`, a build artifact that `bun run
 * normalize` generates and that is git-ignored. Any script importing shared.ts
 * therefore refused to start on a fresh checkout — that is exactly how the
 * nightly sync workflow failed every night since July with
 * `Cannot find module '../../output/catalog-seeds.json'`, before it ever
 * reached KV. Ordering a `normalize` step in front of the sync would hide that
 * in CI only; breaking the import is smaller and fixes every caller, including
 * `bun scripts/batch/sync-kv.ts --help` on a clean clone.
 *
 * shared.ts re-exports everything here, so existing importers are unaffected.
 */
export const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

export type Args = {
  flags: Map<string, string[]>;
  positionals: string[];
};

export function parseArgs(argv = Bun.argv.slice(2)): Args {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    const value = eq >= 0 ? raw.slice(eq + 1) : argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
    const values = flags.get(key) ?? [];
    values.push(value);
    flags.set(key, values);
  }
  return { flags, positionals };
}

export const hasFlag = (args: Args, name: string): boolean => args.flags.has(name);
export const getFlag = (args: Args, name: string, fallback?: string): string | undefined => args.flags.get(name)?.at(-1) ?? fallback;
export const getNumberFlag = (args: Args, name: string, fallback: number): number => {
  const n = Number(getFlag(args, name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function usage(text: string): never {
  console.log(text.trimStart());
  process.exit(0);
}
