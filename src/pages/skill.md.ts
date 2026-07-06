import type { APIRoute } from "astro";
import skillMarkdown from "../../cli/src/skill.md?raw";

export const GET: APIRoute = () =>
  new Response(skillMarkdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=3600",
    },
  });
