import { describe, expect, test } from "bun:test";
import { recordToSurface } from "./catalog-to-discovery.ts";
import type { Integration } from "./types.ts";

const cli = (cliFields: Integration["cli"]): Integration => ({
  id: "curated/github-com-cli",
  kind: "cli",
  slug: "github-com-cli",
  name: "GitHub",
  description: "",
  categories: [],
  feeds: ["curated"],
  cli: cliFields,
  raw: {},
});

describe("recordToSurface", () => {
  test("a curated CLI publishes its real command, not its record slug", () => {
    const surface = recordToSurface(cli({ install: "brew install gh", command: "gh", domain: "github.com" }));
    expect(surface?.command).toBe("gh");
  });

  test("a feed CLI without a command keeps using its slug", () => {
    const surface = recordToSurface(cli({ install: "brew install gh", domain: "github.com" }));
    expect(surface?.command).toBe("github-com-cli");
  });
});
