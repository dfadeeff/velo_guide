import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// NOTE: DuckDuckGo's Instant Answer API has shallow coverage and returns
// nothing for most real queries (events, ferry schedules, seasonal info). It is
// kept as a best-effort, time-bounded hook; the production upgrade is a real
// search API (Brave/Tavily) — see DECISIONS.md. We intentionally do NOT scrape
// the lite.duckduckgo.com HTML page: it was slow (no timeout), fragile, against
// ToS, and still returned nothing useful — which made the agent burn ~8s per
// call and retry repeatedly.
export const webSearchTool: ToolDefinition = {
  name: "web_search",
  label: "Web Search",
  description:
    "Best-effort web lookup for time-sensitive context not available through other tools (seasonal events, festivals). Coverage is shallow and it often returns nothing — call it AT MOST ONCE, and if it returns no results, do not retry; proceed with the plan.",
  parameters: Type.Object({
    query: Type.String({
      description: "Search query. Add 'Netherlands' or 'cycling' for more relevant results.",
    }),
  }),
  execute: async (_toolCallId, params: any) => {
    try {
      const res = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(params.query)}&format=json&no_html=1&skip_disambig=1`,
        { headers: { "User-Agent": "VeloGuide/1.0" }, signal: AbortSignal.timeout(6000) },
      );

      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Search unavailable (${res.status}).` }], details: {} };
      }

      const data = await res.json();
      const results: string[] = [];

      if (data.Abstract) {
        results.push(`**${data.Heading}**: ${data.Abstract}`);
        if (data.AbstractURL) results.push(`Source: ${data.AbstractURL}`);
      }

      for (const topic of (data.RelatedTopics ?? []).slice(0, 8)) {
        if (topic.Text) {
          results.push(`- ${topic.Text}`);
          if (topic.FirstURL) results.push(`  Link: ${topic.FirstURL}`);
        }
      }

      if (!results.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results for "${params.query}". Web search has limited coverage — proceed using your own knowledge and the other tools; do not retry this search.`,
            },
          ],
          details: {},
        };
      }

      return {
        content: [{ type: "text" as const, text: `Search results for "${params.query}":\n\n${results.join("\n")}` }],
        details: {},
      };
    } catch (err: any) {
      return {
        content: [
          { type: "text" as const, text: `Search unavailable (${err.message}). Proceed without it; do not retry.` },
        ],
        details: {},
      };
    }
  },
};
