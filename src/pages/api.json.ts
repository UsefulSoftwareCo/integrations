import type { APIRoute } from "astro";
import { apiEnvelope } from "~/lib/api-envelope.ts";
import { index } from "~/lib/data.ts";

// GET /api.json — the whole enriched registry index as one file, prerendered
// at build from output/index.json (the same records every page renders from).
// The page you read and the data your agent fetches are the same content.
export const GET: APIRoute = () =>
  new Response(JSON.stringify(apiEnvelope(index)), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=3600",
    },
  });
