import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  label: "Web Search",
  description:
    "Search the web for information not available through other tools. Use for: seasonal events (tulip festivals, cycling events), specific restaurant/cafe reviews, local cycling tips, ferry schedules, train+bike connections, and other contextual information about the Netherlands.",
  parameters: Type.Object({
    query: Type.String({
      description: "Search query. Add 'Netherlands' or 'cycling' for more relevant results.",
    }),
  }),
  execute: async (_toolCallId, params: any) => {
    try {
      const res = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(params.query)}&format=json&no_html=1&skip_disambig=1`,
        { headers: { "User-Agent": "VeloGuide/1.0" } },
      );

      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${res.status}` }],
          details: {},
        };
      }

      const data = await res.json();
      const results: string[] = [];

      if (data.Abstract) {
        results.push(`**${data.Heading}**: ${data.Abstract}`);
        if (data.AbstractURL) results.push(`Source: ${data.AbstractURL}`);
      }

      if (data.RelatedTopics?.length) {
        const topics = data.RelatedTopics.slice(0, 8);
        for (const topic of topics) {
          if (topic.Text) {
            results.push(`- ${topic.Text}`);
            if (topic.FirstURL) results.push(`  Link: ${topic.FirstURL}`);
          }
        }
      }

      if (!results.length) {
        const liteRes = await fetch(
          `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(params.query)}`,
          { headers: { "User-Agent": "VeloGuide/1.0" } },
        );

        if (liteRes.ok) {
          const html = await liteRes.text();
          const snippetMatches = html.match(/<td class="result-snippet">(.*?)<\/td>/gs);
          const linkMatches = html.match(/<a rel="nofollow" href="(.*?)" class="result-link">(.*?)<\/a>/gs);

          if (snippetMatches?.length) {
            for (let i = 0; i < Math.min(snippetMatches.length, 5); i++) {
              const snippet = snippetMatches[i].replace(/<[^>]+>/g, "").trim();
              const link = linkMatches?.[i]?.replace(/<[^>]+>/g, "").trim();
              results.push(`- ${snippet}${link ? `\n  Source: ${link}` : ""}`);
            }
          }
        }
      }

      if (!results.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No useful results found for "${params.query}". Try rephrasing the query.`,
            },
          ],
          details: {},
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Search results for "${params.query}":\n\n${results.join("\n")}`,
          },
        ],
        details: {},
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Search error: ${err.message}` }],
        details: {},
      };
    }
  },
};
