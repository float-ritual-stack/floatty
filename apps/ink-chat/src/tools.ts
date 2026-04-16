/**
 * Tools for the ink-chat example.
 *
 * All tools use free, public APIs — no API keys required beyond the
 * AI Gateway key that is already configured.
 *
 * These match the tools in examples/chat for consistency across examples.
 */

import { tool, generateText } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { z } from "zod";
import { experimental_createSkillTool as createSkillTool } from "bash-tool";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { blocksToSpec, type OutlineBlock } from "./block-to-spec";

// =============================================================================
// Web Search (Perplexity Sonar via AI Gateway)
// =============================================================================

export const webSearch = tool({
  description:
    "Search the web for current information on any topic. Returns a synthesized answer based on real-time web data.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "The search query — be specific and include relevant context for better results",
      ),
  }),
  execute: async ({ query }) => {
    try {
      const { text } = await generateText({
        model: gateway("perplexity/sonar"),
        prompt: query,
      });
      return { content: text };
    } catch (error) {
      return {
        error: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

// =============================================================================
// Weather (Open-Meteo — free, no API key)
// =============================================================================

function describeWeatherCode(code: number): string {
  const descriptions: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snow",
    73: "Moderate snow",
    75: "Heavy snow",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    95: "Thunderstorm",
  };
  return descriptions[code] ?? "Unknown";
}

export const getWeather = tool({
  description:
    "Get current weather conditions and a 7-day forecast for a given city. Returns temperature, humidity, wind speed, weather conditions, and daily forecasts.",
  inputSchema: z.object({
    city: z
      .string()
      .describe("City name (e.g., 'New York', 'London', 'Tokyo')"),
  }),
  execute: async ({ city }) => {
    try {
      const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
      const geocodeRes = await fetch(geocodeUrl);

      if (!geocodeRes.ok) {
        return { error: `Failed to geocode city: ${city}` };
      }

      const geocodeData = (await geocodeRes.json()) as {
        results?: Array<{
          name: string;
          country: string;
          latitude: number;
          longitude: number;
          timezone: string;
        }>;
      };

      if (!geocodeData.results || geocodeData.results.length === 0) {
        return { error: `City not found: ${city}` };
      }

      const location = geocodeData.results[0]!;

      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=${encodeURIComponent(location.timezone)}&forecast_days=7`;

      const weatherRes = await fetch(weatherUrl);

      if (!weatherRes.ok) {
        return { error: "Failed to fetch weather data" };
      }

      const weather = (await weatherRes.json()) as {
        current: {
          temperature_2m: number;
          relative_humidity_2m: number;
          apparent_temperature: number;
          weather_code: number;
          wind_speed_10m: number;
        };
        daily: {
          time: string[];
          weather_code: number[];
          temperature_2m_max: number[];
          temperature_2m_min: number[];
          precipitation_sum: number[];
        };
      };

      const forecast = weather.daily.time.map((date, i) => ({
        date,
        day: new Date(date + "T12:00:00").toLocaleDateString("en-US", {
          weekday: "short",
        }),
        high: Math.round(weather.daily.temperature_2m_max[i]!),
        low: Math.round(weather.daily.temperature_2m_min[i]!),
        condition: describeWeatherCode(weather.daily.weather_code[i]!),
        precipitation: weather.daily.precipitation_sum[i]!,
      }));

      return {
        city: location.name,
        country: location.country,
        current: {
          temperature: Math.round(weather.current.temperature_2m),
          feelsLike: Math.round(weather.current.apparent_temperature),
          humidity: weather.current.relative_humidity_2m,
          windSpeed: Math.round(weather.current.wind_speed_10m),
          condition: describeWeatherCode(weather.current.weather_code),
        },
        forecast,
      };
    } catch (error) {
      return {
        error: `Weather fetch failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

// =============================================================================
// Hacker News (Firebase API — free, no API key)
// =============================================================================

export const getHackerNewsTop = tool({
  description:
    "Get the current top stories from Hacker News, including title, score, author, URL, and comment count.",
  inputSchema: z.object({
    count: z
      .number()
      .min(1)
      .max(30)
      .describe("Number of top stories to fetch (1-30)"),
  }),
  execute: async ({ count }) => {
    try {
      const topRes = await fetch(
        "https://hacker-news.firebaseio.com/v0/topstories.json?print=pretty",
        { signal: AbortSignal.timeout(5000) },
      );

      if (!topRes.ok) {
        return { error: "Failed to fetch Hacker News top stories" };
      }

      const topIds = (await topRes.json()) as number[];
      const storyIds = topIds.slice(0, count);

      const stories = await Promise.all(
        storyIds.map(async (id) => {
          const storyRes = await fetch(
            `https://hacker-news.firebaseio.com/v0/item/${id}.json?print=pretty`,
            { signal: AbortSignal.timeout(5000) },
          );
          if (!storyRes.ok) return null;

          const story = (await storyRes.json()) as {
            id: number;
            title: string;
            url?: string;
            score: number;
            by: string;
            time: number;
            descendants?: number;
          };

          return {
            title: story.title,
            url:
              story.url ?? `https://news.ycombinator.com/item?id=${story.id}`,
            score: story.score,
            author: story.by,
            comments: story.descendants ?? 0,
          };
        }),
      );

      return {
        stories: stories.filter(Boolean),
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        error: `Hacker News fetch failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

// =============================================================================
// GitHub (Public API — free, no API key, 60 req/hr)
// =============================================================================

const ghHeaders = { Accept: "application/vnd.github.v3+json" };

export const getGitHubRepo = tool({
  description:
    "Get information about a public GitHub repository including stars, forks, open issues, description, and language breakdown.",
  inputSchema: z.object({
    owner: z.string().describe("Repository owner (e.g., 'vercel')"),
    repo: z.string().describe("Repository name (e.g., 'next.js')"),
  }),
  execute: async ({ owner, repo }) => {
    try {
      const repoUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

      const [repoRes, languagesRes] = await Promise.all([
        fetch(repoUrl, { headers: ghHeaders }),
        fetch(`${repoUrl}/languages`, { headers: ghHeaders }),
      ]);

      if (!repoRes.ok) {
        if (repoRes.status === 404)
          return { error: `Not found: ${owner}/${repo}` };
        return { error: `Failed to fetch repo: ${repoRes.statusText}` };
      }

      const repoData = (await repoRes.json()) as {
        full_name: string;
        description: string | null;
        html_url: string;
        stargazers_count: number;
        forks_count: number;
        open_issues_count: number;
        language: string | null;
        license: { spdx_id: string } | null;
        topics: string[];
      };

      const languages: Record<string, number> = languagesRes.ok
        ? ((await languagesRes.json()) as Record<string, number>)
        : {};

      const totalBytes = Object.values(languages).reduce((a, b) => a + b, 0);
      const languageBreakdown = Object.entries(languages)
        .map(([lang, bytes]) => ({
          language: lang,
          percentage:
            totalBytes > 0 ? Math.round((bytes / totalBytes) * 100) : 0,
        }))
        .sort((a, b) => b.percentage - a.percentage)
        .slice(0, 6);

      return {
        name: repoData.full_name,
        description: repoData.description,
        url: repoData.html_url,
        stars: repoData.stargazers_count,
        forks: repoData.forks_count,
        openIssues: repoData.open_issues_count,
        primaryLanguage: repoData.language,
        license: repoData.license?.spdx_id ?? "None",
        topics: repoData.topics,
        languages: languageBreakdown,
      };
    } catch (error) {
      return {
        error: `GitHub fetch failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

// =============================================================================
// Crypto (CoinGecko — free, no API key)
// =============================================================================

export const getCryptoPrice = tool({
  description:
    "Get current price, market cap, 24h change, and 7-day trend for a cryptocurrency.",
  inputSchema: z.object({
    coinId: z
      .string()
      .describe(
        "CoinGecko coin ID (e.g., 'bitcoin', 'ethereum', 'solana', 'dogecoin')",
      ),
  }),
  execute: async ({ coinId }) => {
    try {
      const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;

      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        if (res.status === 404)
          return { error: `Cryptocurrency not found: ${coinId}` };
        if (res.status === 429)
          return {
            error: "CoinGecko rate limit exceeded. Try again in a minute.",
          };
        return { error: `Failed to fetch crypto data: ${res.statusText}` };
      }

      const data = (await res.json()) as {
        id: string;
        symbol: string;
        name: string;
        market_data: {
          current_price: { usd: number };
          market_cap: { usd: number };
          total_volume: { usd: number };
          price_change_percentage_24h: number;
          price_change_percentage_7d: number;
          high_24h: { usd: number };
          low_24h: { usd: number };
        };
        market_cap_rank: number;
      };

      const md = data.market_data;

      return {
        symbol: data.symbol.toUpperCase(),
        name: data.name,
        rank: data.market_cap_rank,
        price: md.current_price.usd,
        marketCap: md.market_cap.usd,
        volume24h: md.total_volume.usd,
        change24h: Math.round(md.price_change_percentage_24h * 100) / 100,
        change7d: Math.round(md.price_change_percentage_7d * 100) / 100,
        high24h: md.high_24h.usd,
        low24h: md.low_24h.usd,
      };
    } catch (error) {
      return {
        error: `Crypto fetch failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

// =============================================================================
// Floatty Outliner (local REST API)
// =============================================================================

const FLOATTY_URL = process.env.FLOATTY_URL;
const FLOATTY_API_KEY = process.env.FLOATTY_API_KEY;

if (!FLOATTY_URL || !FLOATTY_API_KEY) {
  throw new Error(
    "FLOATTY_URL and FLOATTY_API_KEY env vars are required. " +
    "Set them in .env or export before running."
  );
}

const floattyHeaders = {
  Authorization: `Bearer ${FLOATTY_API_KEY}`,
  "Content-Type": "application/json",
};

async function floattyFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${FLOATTY_URL}${path}`, {
    ...init,
    headers: { ...floattyHeaders, ...init?.headers },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Floatty ${res.status}: ${body}`);
  }
  return res.json();
}

// =============================================================================
// Wikilink resolver — extracts [[links]] from text, resolves against floatty
// =============================================================================

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

export function extractWikilinks(text: string): string[] {
  const links: string[] = [];
  let match;
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    links.push(match[1]!);
  }
  return [...new Set(links)];
}

interface ResolvedLink {
  name: string;
  blockId: string;
  content: string;
  blocks: Array<{ content: string; depth: number }>;
}

export async function resolveWikilinks(
  links: string[],
): Promise<ResolvedLink[]> {
  const resolved: ResolvedLink[] = [];

  for (const link of links) {
    try {
      // Search for the page by name (fuzzy to handle slight variations)
      const pages = (await floattyFetch(
        `/api/v1/pages/search?prefix=${encodeURIComponent(link)}&limit=3&fuzzy=true`,
      )) as {
        pages: Array<{ name: string; isStub: boolean; blockId: string | null }>;
      };

      // Try exact prefix match first, then fuzzy
      const page = pages.pages.find((p) => !p.isStub && p.blockId);

      if (page?.blockId) {
        // Fetch page tree
        const tree = (await floattyFetch(
          `/api/v1/blocks/${page.blockId}?include=tree&max_depth=5`,
        )) as {
          id: string;
          content: string;
          metadata?: { renderedMarkdown?: string };
          tree?: Array<{ id: string; content: string; depth: number }>;
        };

        resolved.push({
          name: link,
          blockId: page.blockId.slice(0, 8),
          content: tree.metadata?.renderedMarkdown ?? tree.content,
          blocks:
            tree.tree?.slice(0, 50).map((b) => ({
              content: b.content,
              depth: b.depth,
            })) ?? [],
        });
        continue;
      }

      // Fallback: search for heading content (handles daily notes under pages::)
      const search = (await floattyFetch(
        `/api/v1/search?q=${encodeURIComponent(`# ${link}`)}&limit=3`,
      )) as { hits: Array<{ blockId: string; content: string }> };

      const hit = search.hits.find(
        (h) => h.content.trim() === `# ${link}` || h.content.trim() === link,
      );

      if (hit) {
        const tree = (await floattyFetch(
          `/api/v1/blocks/${hit.blockId}?include=tree&max_depth=5`,
        )) as {
          id: string;
          content: string;
          metadata?: { renderedMarkdown?: string };
          tree?: Array<{ id: string; content: string; depth: number }>;
        };

        resolved.push({
          name: link,
          blockId: hit.blockId.slice(0, 8),
          content: tree.metadata?.renderedMarkdown ?? tree.content,
          blocks:
            tree.tree?.slice(0, 50).map((b) => ({
              content: b.content,
              depth: b.depth,
            })) ?? [],
        });
      }
    } catch {
      // Skip unresolvable links silently
    }
  }

  return resolved;
}

export async function searchPages(
  query: string,
): Promise<Array<{ name: string; isStub: boolean }>> {
  try {
    const params = new URLSearchParams({
      prefix: query,
      limit: "8",
      fuzzy: "true",
    });
    const data = (await floattyFetch(`/api/v1/pages/search?${params}`)) as {
      pages: Array<{ name: string; isStub: boolean }>;
    };
    return data.pages;
  } catch {
    return [];
  }
}

// =============================================================================
// Auto-enrichment — search outline for relevant context without explicit [[]]
// =============================================================================

interface EnrichmentHit {
  blockId: string;
  content: string;
  score: number;
  breadcrumb: string[];
  markers: Array<{ markerType: string; value?: string }>;
}

/** Extract searchable entities from raw text: dates, issue IDs, page-like terms */
function extractSearchTerms(text: string): string[] {
  const terms: string[] = [];

  // Dates: YYYY-MM-DD, "yesterday", "today", "last week", etc.
  const dateMatches = text.match(/\d{4}-\d{2}-\d{2}/g);
  if (dateMatches) terms.push(...dateMatches);

  // Issue IDs: FLO-123, #1234, Issue #1234
  const issueMatches = text.match(/(?:FLO-\d+|#\d{3,}|issue\s*#?\d+)/gi);
  if (issueMatches) terms.push(...issueMatches);

  // PR refs: PR #1234
  const prMatches = text.match(/PR\s*#?\d+/gi);
  if (prMatches) terms.push(...prMatches);

  return [...new Set(terms)];
}

export interface EnrichmentResult {
  contextText: string;
  /** Short labels for what was found (shown to user) */
  labels: string[];
}

export async function autoEnrich(text: string): Promise<EnrichmentResult> {
  const empty: EnrichmentResult = { contextText: "", labels: [] };
  // Skip enrichment for very short messages, greetings, or form submissions
  if (text.length < 10 || text.startsWith("[Form submitted]")) return empty;

  const allHits: EnrichmentHit[] = [];

  // 1. Search with the full user text (BM25 finds relevant blocks)
  try {
    const data = (await floattyFetch(
      `/api/v1/search?q=${encodeURIComponent(text.slice(0, 200))}&limit=5&include_breadcrumb=true&include_metadata=true`,
    )) as {
      hits: Array<{
        blockId: string;
        content: string;
        score: number;
        breadcrumb: string[];
        metadata: { markers: Array<{ markerType: string; value?: string }> };
      }>;
    };
    for (const h of data.hits) {
      if (h.score > 5) {
        allHits.push({
          blockId: h.blockId,
          content: h.content,
          score: h.score,
          breadcrumb: h.breadcrumb,
          markers: h.metadata?.markers ?? [],
        });
      }
    }
  } catch {
    // Non-fatal
  }

  // 2. Search specific extracted entities (dates, issues, PRs)
  const entities = extractSearchTerms(text);
  for (const entity of entities.slice(0, 3)) {
    try {
      const data = (await floattyFetch(
        `/api/v1/search?q=${encodeURIComponent(entity)}&limit=3&include_breadcrumb=true&include_metadata=true`,
      )) as {
        hits: Array<{
          blockId: string;
          content: string;
          score: number;
          breadcrumb: string[];
          metadata: { markers: Array<{ markerType: string; value?: string }> };
        }>;
      };
      for (const h of data.hits) {
        if (!allHits.some((x) => x.blockId === h.blockId)) {
          allHits.push({
            blockId: h.blockId,
            content: h.content,
            score: h.score,
            breadcrumb: h.breadcrumb,
            markers: h.metadata?.markers ?? [],
          });
        }
      }
    } catch {
      // Non-fatal
    }
  }

  if (!allHits.length) return empty;

  // Sort by score, take top 10
  allHits.sort((a, b) => b.score - a.score);
  const top = allHits.slice(0, 10);

  // Build labels from breadcrumbs (unique page-level locations)
  const labelSet = new Set<string>();
  for (const h of top) {
    const bc = h.breadcrumb ?? [];
    const page = bc.find((b) => b.startsWith("# "));
    if (page) labelSet.add(page.replace(/^# /, ""));
    else if (bc.length) labelSet.add(bc[0]!);
  }

  const lines = top.map((h) => {
    const bc = h.breadcrumb ?? [];
    const loc = bc.length ? bc.join(" > ") : "root";
    const markers = h.markers
      .map((m) =>
        m.value ? `${m.markerType}::${m.value}` : `${m.markerType}::`,
      )
      .join(" ");
    return `- [${h.blockId.slice(0, 8)}] ${h.content}${markers ? ` {${markers}}` : ""}\n  Location: ${loc}`;
  });

  return {
    contextText: `\n---\nOUTLINE CONTEXT (auto-retrieved from floatty — use if relevant, ignore if not):\n${lines.join("\n")}\n---\n`,
    labels: [...labelSet].slice(0, 5),
  };
}

export function formatResolvedLinks(links: ResolvedLink[]): string {
  if (!links.length) return "";

  const sections = links.map((link) => {
    const tree = link.blocks
      .map((b) => `${"  ".repeat(b.depth)}- ${b.content}`)
      .join("\n");
    return `## [[${link.name}]] (${link.blockId})\n${tree}`;
  });

  return `\n---\nRESOLVED OUTLINE CONTEXT:\n${sections.join("\n\n")}\n---\n`;
}

export const floattySearch = tool({
  description:
    "Search the floatty outliner for blocks matching a query. Returns blocks with breadcrumbs (location in tree), relevance scores, and metadata (markers like ctx::, project::, mode:: and [[wikilink]] outlinks). Use for finding notes, context markers, daily entries, or any outline content.",
  inputSchema: z.object({
    query: z.string().describe("Full-text search query"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe("Max results (default 20)"),
    marker_type: z
      .string()
      .optional()
      .describe(
        "Filter by marker type (e.g., 'project', 'ctx', 'mode', 'todo')",
      ),
    marker_val: z
      .string()
      .optional()
      .describe(
        "Filter by marker value (requires marker_type, e.g., marker_type='project', marker_val='floatty')",
      ),
  }),
  execute: async ({ query, limit, marker_type, marker_val }) => {
    try {
      const params = new URLSearchParams({
        q: query,
        limit: String(limit ?? 20),
        include_breadcrumb: "true",
        include_metadata: "true",
      });
      if (marker_type) params.set("marker_type", marker_type);
      if (marker_val) params.set("marker_val", marker_val);

      const data = (await floattyFetch(`/api/v1/search?${params}`)) as {
        hits: Array<{
          blockId: string;
          score: number;
          content: string;
          snippet: string | null;
          breadcrumb: string[];
          metadata: {
            markers: Array<{ markerType: string; value?: string }>;
            outlinks: string[];
          };
        }>;
        total: number;
      };

      return {
        total: data.total,
        hits: data.hits.map((h) => ({
          blockId: h.blockId.slice(0, 8),
          score: Math.round(h.score * 100) / 100,
          content: h.content,
          breadcrumb: h.breadcrumb,
          markers: h.metadata?.markers ?? [],
          outlinks: h.metadata?.outlinks ?? [],
        })),
      };
    } catch (error) {
      return {
        error: `Floatty search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

export const floattyPage = tool({
  description:
    "Get a full page from the floatty outliner as a tree. Pages are root-level blocks with headings. Use a short-hash prefix (8 chars) or page name search. Returns the block tree with content, children, and depth for rendering as an indented outline.",
  inputSchema: z.object({
    page_prefix: z
      .string()
      .describe(
        "Short-hash prefix (e.g., '5696d8b9') or full UUID of a root block",
      ),
  }),
  execute: async ({ page_prefix }) => {
    try {
      // Resolve prefix to full ID
      const resolved = (await floattyFetch(
        `/api/v1/blocks/resolve/${encodeURIComponent(page_prefix)}`,
      )) as { id: string; block: { content: string } };

      // Get full tree
      const tree = (await floattyFetch(
        `/api/v1/blocks/${resolved.id}?include=tree,token_estimate`,
      )) as {
        id: string;
        content: string;
        childIds: string[];
        metadata?: {
          renderedMarkdown?: string;
        };
        tree?: Array<{ id: string; content: string; depth: number }>;
        tokenEstimate?: {
          totalChars: number;
          blockCount: number;
          maxDepth: number;
        };
      };

      const blocks: OutlineBlock[] =
        tree.tree?.map((b) => ({
          id: b.id,
          content: b.content,
          depth: b.depth,
        })) ?? [];

      return {
        id: resolved.id.slice(0, 8),
        title: tree.content,
        ...(tree.metadata?.renderedMarkdown && {
          renderedMarkdown: tree.metadata.renderedMarkdown,
        }),
        blockCount: tree.tokenEstimate?.blockCount ?? 0,
        maxDepth: tree.tokenEstimate?.maxDepth ?? 0,
        blocks: blocks.map((b) => ({
          id: b.id.slice(0, 8),
          content: b.content,
          depth: b.depth,
        })),
        treeSpec: blocksToSpec(blocks, { maxBlocks: 40, truncateAt: 150 }),
      };
    } catch (error) {
      return {
        error: `Floatty page failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

export const floattySearchPages = tool({
  description:
    "Search for pages (root-level blocks) in the floatty outliner by name. Supports fuzzy matching. Use this to find a page before loading it with floatty_page.",
  inputSchema: z.object({
    query: z.string().describe("Page name search (prefix or fuzzy)"),
    fuzzy: z
      .boolean()
      .optional()
      .describe("Use fuzzy matching (typo-tolerant, default false)"),
    limit: z
      .number()
      .min(1)
      .max(30)
      .optional()
      .describe("Max results (default 10)"),
  }),
  execute: async ({ query, fuzzy, limit }) => {
    try {
      const params = new URLSearchParams({
        prefix: query,
        limit: String(limit ?? 10),
      });
      if (fuzzy) params.set("fuzzy", "true");

      const data = (await floattyFetch(`/api/v1/pages/search?${params}`)) as {
        pages: Array<{ name: string; isStub: boolean; blockId: string | null }>;
      };

      return {
        pages: data.pages.map((p) => ({
          name: p.name,
          isStub: p.isStub,
          blockId: p.blockId?.slice(0, 8) ?? null,
        })),
      };
    } catch (error) {
      return {
        error: `Floatty page search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

export const floattyDaily = tool({
  description:
    "Get today's daily note from the floatty outliner. Returns the full tree of today's note including timelog entries, ctx:: markers, and session notes.",
  inputSchema: z.object({
    date: z
      .string()
      .optional()
      .describe("Date in YYYY-MM-DD format (defaults to today)"),
  }),
  execute: async ({ date }) => {
    try {
      const targetDate = date ?? new Date().toISOString().split("T")[0];

      // Search for the daily note heading block (e.g. "# 2026-03-27")
      // Daily notes live as children of the pages:: root, with content "# YYYY-MM-DD"
      const heading = `# ${targetDate}`;
      const search = (await floattyFetch(
        `/api/v1/search?q=${encodeURIComponent(heading)}&limit=5&include_breadcrumb=true`,
      )) as {
        hits: Array<{
          blockId: string;
          content: string;
          breadcrumb: string[];
        }>;
      };

      // Find the exact heading match (content === "# YYYY-MM-DD")
      const dailyHit = search.hits.find((h) => h.content.trim() === heading);

      if (!dailyHit) {
        return { error: `No daily note found for ${targetDate}` };
      }

      // Get tree from the block
      const tree = (await floattyFetch(
        `/api/v1/blocks/${dailyHit.blockId}?include=tree,token_estimate`,
      )) as {
        id: string;
        content: string;
        tree?: Array<{ id: string; content: string; depth: number }>;
        tokenEstimate?: {
          totalChars: number;
          blockCount: number;
        };
      };

      const blocks: OutlineBlock[] =
        tree.tree?.map((b) => ({
          id: b.id,
          content: b.content,
          depth: b.depth,
        })) ?? [];

      return {
        date: targetDate,
        title: tree.content,
        blockCount: tree.tokenEstimate?.blockCount ?? 0,
        blocks: blocks.map((b) => ({
          id: b.id.slice(0, 8),
          content: b.content,
          depth: b.depth,
        })),
        treeSpec: blocksToSpec(blocks, { maxBlocks: 40, truncateAt: 150 }),
      };
    } catch (error) {
      return {
        error: `Floatty daily failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

export const floattyDailyAdd = tool({
  description:
    "Add an entry to today's daily note in the floatty outliner. Creates the daily note if it doesn't exist.",
  inputSchema: z.object({
    content: z.string().describe("Content to add to today's daily note"),
    parent_id: z
      .string()
      .optional()
      .describe(
        "Optional parent block ID to nest under (defaults to daily note root)",
      ),
  }),
  execute: async ({ content, parent_id }) => {
    try {
      const today = new Date().toISOString().split("T")[0]!;

      // Find or use parent
      let parentId = parent_id;
      if (!parentId) {
        // Find today's daily note heading
        const heading = `# ${today}`;
        const search = (await floattyFetch(
          `/api/v1/search?q=${encodeURIComponent(heading)}&limit=5&include_breadcrumb=true`,
        )) as { hits: Array<{ blockId: string; content: string }> };

        const dailyHit = search.hits.find((h) => h.content.trim() === heading);
        if (dailyHit) {
          parentId = dailyHit.blockId;
        }
      }

      const body: Record<string, string> = { content };
      if (parentId) body.parentId = parentId;

      const block = (await floattyFetch("/api/v1/blocks", {
        method: "POST",
        body: JSON.stringify(body),
      })) as { id: string; content: string };

      return {
        success: true,
        blockId: block.id.slice(0, 8),
        content: block.content,
        parentId: parentId?.slice(0, 8) ?? "root",
      };
    } catch (error) {
      return {
        error: `Floatty daily add failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

export const floattyBlockCreate = tool({
  description:
    "Create a new block in the floatty outliner. Can be a root block or nested under a parent.",
  inputSchema: z.object({
    content: z.string().describe("Block content (text, heading, etc.)"),
    parent_id: z
      .string()
      .optional()
      .describe(
        "Parent block ID (short-hash or full UUID). Omit for root block.",
      ),
    after_id: z
      .string()
      .optional()
      .describe("Insert after this sibling block ID"),
  }),
  execute: async ({ content, parent_id, after_id }) => {
    try {
      // Resolve short-hash parent if needed
      let parentId = parent_id;
      if (parentId && parentId.length < 36) {
        const resolved = (await floattyFetch(
          `/api/v1/blocks/resolve/${encodeURIComponent(parentId)}`,
        )) as { id: string };
        parentId = resolved.id;
      }

      let afterId = after_id;
      if (afterId && afterId.length < 36) {
        const resolved = (await floattyFetch(
          `/api/v1/blocks/resolve/${encodeURIComponent(afterId)}`,
        )) as { id: string };
        afterId = resolved.id;
      }

      const body: Record<string, string> = { content };
      if (parentId) body.parentId = parentId;
      if (afterId) body.afterId = afterId;

      const block = (await floattyFetch("/api/v1/blocks", {
        method: "POST",
        body: JSON.stringify(body),
      })) as { id: string; content: string; parentId: string | null };

      return {
        success: true,
        blockId: block.id.slice(0, 8),
        content: block.content,
        parentId: block.parentId?.slice(0, 8) ?? "root",
      };
    } catch (error) {
      return {
        error: `Floatty block create failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

export const floattyPresence = tool({
  description:
    "Get the user's current focus position in the floatty outliner — which block they're looking at right now. Returns the focused block with its content and surrounding context.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const res = await fetch(`${FLOATTY_URL}/api/v1/presence`, {
        headers: floattyHeaders,
        signal: AbortSignal.timeout(5000),
      });

      if (res.status === 204) {
        return { focused: false, message: "No active focus in outliner" };
      }

      if (!res.ok) throw new Error(`${res.status}`);

      const presence = (await res.json()) as {
        blockId: string;
        paneId: string | null;
      };

      // Get block with context
      const block = (await floattyFetch(
        `/api/v1/blocks/${presence.blockId}?include=ancestors,siblings,children&sibling_radius=3`,
      )) as {
        id: string;
        content: string;
        parentId: string | null;
        childIds: string[];
        metadata?: {
          renderedMarkdown?: string;
        };
        ancestors?: Array<{ id: string; content: string }>;
        siblings?: {
          before: Array<{ id: string; content: string }>;
          after: Array<{ id: string; content: string }>;
        };
        children?: Array<{ id: string; content: string }>;
      };

      return {
        focused: true,
        blockId: block.id.slice(0, 8),
        content: block.content,
        ...(block.metadata?.renderedMarkdown && {
          renderedMarkdown: block.metadata.renderedMarkdown,
        }),
        ancestors: block.ancestors?.map((a) => a.content) ?? [],
        siblingsBefore: block.siblings?.before.map((s) => s.content) ?? [],
        siblingsAfter: block.siblings?.after.map((s) => s.content) ?? [],
        children: block.children?.map((c) => c.content) ?? [],
      };
    } catch (error) {
      return {
        error: `Floatty presence failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

export const floattyMarkers = tool({
  description:
    "Discover what marker types and values exist in the outline. Use to understand the vocabulary (project::, ctx::, mode::, etc.) before searching.",
  inputSchema: z.object({
    marker_type: z
      .string()
      .optional()
      .describe(
        "Get values for a specific marker type (e.g., 'project'). Omit to list all marker types.",
      ),
  }),
  execute: async ({ marker_type }) => {
    try {
      if (marker_type) {
        const data = (await floattyFetch(
          `/api/v1/markers/${encodeURIComponent(marker_type)}/values`,
        )) as {
          markerType: string;
          total: number;
          values: Array<{ value: string; count: number }>;
        };
        return data;
      }

      const data = (await floattyFetch("/api/v1/markers")) as Record<
        string,
        unknown
      >;
      return data;
    } catch (error) {
      return {
        error: `Floatty markers failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

// =============================================================================
// Floatty tools — graph walking
// =============================================================================

export const floattyBacklinks = tool({
  description:
    "Find blocks that link TO a specific page via [[wikilinks]]. The reverse graph walk — given a page name, find everything pointing at it. Uses the server-side outlink index (exact match, fast).",
  inputSchema: z.object({
    target: z
      .string()
      .describe(
        "The wikilink target to find backlinks for (e.g., 'FLO-201', '2026-01-21', 'Issue #1540'). Exact match against [[wikilink]] targets.",
      ),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe("Max results (default 20)"),
  }),
  execute: async ({ target, limit }) => {
    try {
      const params = new URLSearchParams({
        outlink: target,
        include_metadata: "true",
        include_breadcrumb: "true",
        limit: String(limit ?? 20),
      });

      const data = (await floattyFetch(`/api/v1/search?${params}`)) as {
        hits: Array<{
          blockId: string;
          score: number;
          content: string;
          breadcrumb: string[];
          metadata: {
            markers: Array<{ markerType: string; value?: string }>;
            outlinks: string[];
          };
        }>;
        total: number;
      };

      return {
        target,
        total: data.total,
        hits: data.hits.map((h) => ({
          blockId: h.blockId.slice(0, 8),
          content: h.content,
          breadcrumb: h.breadcrumb,
          markers: h.metadata?.markers ?? [],
          outlinks: h.metadata?.outlinks ?? [],
        })),
      };
    } catch (error) {
      return {
        error: `Floatty backlinks failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

export const floattyBlockContext = tool({
  description:
    "Get a block with its full surrounding context: ancestors (parent chain up to root), siblings (blocks before/after at the same level), and children. Essential for timeline views and understanding sequences.",
  inputSchema: z.object({
    block_id: z.string().describe("Block ID (short-hash prefix or full UUID)"),
    sibling_radius: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe("Number of siblings before/after to include (default 3)"),
  }),
  execute: async ({ block_id, sibling_radius }) => {
    try {
      let fullId = block_id;
      if (fullId.length < 36) {
        const resolved = (await floattyFetch(
          `/api/v1/blocks/resolve/${encodeURIComponent(fullId)}`,
        )) as { id: string };
        fullId = resolved.id;
      }

      const radius = sibling_radius ?? 3;
      const block = (await floattyFetch(
        `/api/v1/blocks/${fullId}?include=ancestors,siblings,children&sibling_radius=${radius}`,
      )) as {
        id: string;
        content: string;
        parentId: string | null;
        metadata?: {
          markers: Array<{ markerType: string; value?: string }>;
          outlinks: string[];
          renderedMarkdown?: string;
        };
        ancestors?: Array<{ id: string; content: string }>;
        siblings?: {
          before: Array<{ id: string; content: string }>;
          after: Array<{ id: string; content: string }>;
        };
        children?: Array<{ id: string; content: string }>;
      };

      return {
        blockId: block.id.slice(0, 8),
        content: block.content,
        ...(block.metadata?.renderedMarkdown && {
          renderedMarkdown: block.metadata.renderedMarkdown,
        }),
        parentId: block.parentId?.slice(0, 8) ?? null,
        markers: block.metadata?.markers ?? [],
        outlinks: block.metadata?.outlinks ?? [],
        ancestors:
          block.ancestors?.map((a) => ({
            id: a.id.slice(0, 8),
            content: a.content,
          })) ?? [],
        siblingsBefore:
          block.siblings?.before.map((s) => ({
            id: s.id.slice(0, 8),
            content: s.content,
          })) ?? [],
        siblingsAfter:
          block.siblings?.after.map((s) => ({
            id: s.id.slice(0, 8),
            content: s.content,
          })) ?? [],
        children:
          block.children?.map((c) => ({
            id: c.id.slice(0, 8),
            content: c.content,
          })) ?? [],
      };
    } catch (error) {
      return {
        error: `Floatty block context failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

export const floattyStats = tool({
  description:
    "Get outline-wide statistics: total blocks, root count, marker coverage, outlink coverage, and type distribution.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const data = (await floattyFetch("/api/v1/stats")) as {
        totalBlocks: number;
        rootCount: number;
        withMarkers: number;
        withOutlinks: number;
        typeDistribution: Array<[string, number]>;
      };
      return {
        ...data,
        typeDistribution: data.typeDistribution.map(([type, count]) => ({
          type,
          count,
        })),
      };
    } catch (error) {
      return {
        error: `Floatty stats failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

export const floattySearchAdvanced = tool({
  description:
    "Advanced search with filters — no text query required. Filter by marker type/value, temporal ranges (epoch seconds), outlink targets, or parent subtree. Use for 'all project::floatty blocks from last week' or 'ctx:: entries between March 10-15'.",
  inputSchema: z.object({
    query: z.string().optional().describe("Optional text query"),
    marker_type: z.string().optional().describe("Filter by marker type"),
    marker_val: z.string().optional().describe("Filter by marker value"),
    outlink: z.string().optional().describe("Filter by [[wikilink]] target"),
    parent_id: z.string().optional().describe("Search within subtree"),
    created_after: z
      .number()
      .optional()
      .describe("Epoch seconds — blocks created after"),
    created_before: z
      .number()
      .optional()
      .describe("Epoch seconds — blocks created before"),
    ctx_after: z
      .number()
      .optional()
      .describe("Epoch seconds — ctx:: events after"),
    ctx_before: z
      .number()
      .optional()
      .describe("Epoch seconds — ctx:: events before"),
    has_markers: z
      .boolean()
      .optional()
      .describe("Only blocks with :: annotations"),
    inherited: z
      .boolean()
      .optional()
      .describe("Include inherited markers (default true)"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe("Max results (default 20)"),
  }),
  execute: async ({
    query,
    marker_type,
    marker_val,
    outlink,
    parent_id,
    created_after,
    created_before,
    ctx_after,
    ctx_before,
    has_markers,
    inherited,
    limit,
  }) => {
    try {
      const params = new URLSearchParams({
        include_breadcrumb: "true",
        include_metadata: "true",
        limit: String(limit ?? 20),
      });

      if (query) params.set("q", query);
      if (marker_type) params.set("marker_type", marker_type);
      if (marker_val) params.set("marker_val", marker_val);
      if (outlink) params.set("outlink", outlink);
      if (parent_id) params.set("parent_id", parent_id);
      if (created_after !== undefined)
        params.set("created_after", String(created_after));
      if (created_before !== undefined)
        params.set("created_before", String(created_before));
      if (ctx_after !== undefined) params.set("ctx_after", String(ctx_after));
      if (ctx_before !== undefined)
        params.set("ctx_before", String(ctx_before));
      if (has_markers !== undefined)
        params.set("has_markers", String(has_markers));
      if (inherited !== undefined) params.set("inherited", String(inherited));

      const data = (await floattyFetch(`/api/v1/search?${params}`)) as {
        hits: Array<{
          blockId: string;
          score: number;
          content: string;
          breadcrumb: string[];
          metadata: {
            markers: Array<{ markerType: string; value?: string }>;
            outlinks: string[];
          };
        }>;
        total: number;
      };

      return {
        total: data.total,
        hits: data.hits.map((h) => ({
          blockId: h.blockId.slice(0, 8),
          score: Math.round(h.score * 100) / 100,
          content: h.content,
          breadcrumb: h.breadcrumb,
          markers: h.metadata?.markers ?? [],
          outlinks: h.metadata?.outlinks ?? [],
        })),
      };
    } catch (error) {
      return {
        error: `Floatty advanced search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

export const floattyConnections = tool({
  description:
    "Trace graph connections between 2-4 pages/concepts. Finds intersection blocks (reference multiple targets), cross-links, and per-target backlinks. Use when asking 'what connects X and Y?'.",
  inputSchema: z.object({
    targets: z
      .array(z.string())
      .min(2)
      .max(4)
      .describe("Page names or wikilink targets to trace connections between"),
  }),
  execute: async ({ targets }) => {
    try {
      const targetBacklinks: Record<
        string,
        Array<{
          blockId: string;
          content: string;
          breadcrumb: string[];
          outlinks: string[];
        }>
      > = {};

      for (const target of targets) {
        const params = new URLSearchParams({
          outlink: target,
          include_metadata: "true",
          include_breadcrumb: "true",
          limit: "15",
        });

        const data = (await floattyFetch(`/api/v1/search?${params}`)) as {
          hits: Array<{
            blockId: string;
            content: string;
            breadcrumb: string[];
            metadata: { outlinks: string[] };
          }>;
        };

        targetBacklinks[target] = data.hits.map((h) => ({
          blockId: h.blockId,
          content: h.content,
          breadcrumb: h.breadcrumb,
          outlinks: h.metadata?.outlinks ?? [],
        }));
      }

      // Find blocks that reference multiple targets
      const allBlocks = new Map<
        string,
        {
          content: string;
          breadcrumb: string[];
          outlinks: string[];
          refs: string[];
        }
      >();

      for (const [target, hits] of Object.entries(targetBacklinks)) {
        for (const hit of hits) {
          const existing = allBlocks.get(hit.blockId);
          if (existing) {
            existing.refs.push(target);
          } else {
            allBlocks.set(hit.blockId, {
              content: hit.content,
              breadcrumb: hit.breadcrumb,
              outlinks: hit.outlinks,
              refs: [target],
            });
          }
        }
      }

      const intersections = [...allBlocks.entries()]
        .filter(([_, info]) => info.refs.length > 1)
        .map(([id, info]) => ({
          blockId: id.slice(0, 8),
          content: info.content,
          breadcrumb: info.breadcrumb,
          connects: info.refs,
        }))
        .slice(0, 15);

      // Cross-links: targets that reference each other
      const crossLinks: Array<{ from: string; to: string; via: string }> = [];
      for (const [target, hits] of Object.entries(targetBacklinks)) {
        for (const hit of hits) {
          for (const other of targets) {
            if (other !== target && hit.outlinks.includes(other)) {
              crossLinks.push({
                from: target,
                to: other,
                via: hit.content.slice(0, 100),
              });
            }
          }
        }
      }

      return {
        targets,
        intersections,
        crossLinks: [
          ...new Map(
            crossLinks.map((cl) => [`${cl.from}->${cl.to}`, cl]),
          ).values(),
        ],
        perTarget: Object.fromEntries(
          Object.entries(targetBacklinks).map(([t, hits]) => [
            t,
            {
              total: hits.length,
              sample: hits.slice(0, 5).map((h) => ({
                blockId: h.blockId.slice(0, 8),
                content: h.content,
                breadcrumb: h.breadcrumb,
              })),
            },
          ]),
        ),
        summary: {
          totalIntersections: intersections.length,
          totalCrossLinks: crossLinks.length,
          backlinkCounts: Object.fromEntries(
            Object.entries(targetBacklinks).map(([t, hits]) => [
              t,
              hits.length,
            ]),
          ),
        },
      };
    } catch (error) {
      return {
        error: `Floatty connections failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

// =============================================================================
// QMD — local markdown knowledge base search (CLI)
// =============================================================================

async function qmdQuery(
  query: string,
  opts?: { collections?: string[]; limit?: number },
): Promise<
  Array<{
    docid: string;
    score: number;
    file: string;
    title: string;
    snippet: string;
  }>
> {
  const args = ["query", query, "--json"];
  if (opts?.collections) {
    for (const c of opts.collections) {
      args.push("-c", c);
    }
  }
  if (opts?.limit) {
    args.push("-n", String(opts.limit));
  }

  const { execFileSync } = await import("child_process");
  const out = execFileSync("qmd", args, {
    encoding: "utf-8",
    timeout: 30000,
  });
  // QMD outputs status lines before JSON — find the JSON array
  const jsonStart = out.indexOf("[");
  if (jsonStart === -1) return [];
  return JSON.parse(out.slice(jsonStart));
}

export const qmdSearch = tool({
  description:
    "Search the QMD local knowledge base — 10,000+ markdown documents across 24 collections including meeting wraps, daily notes, sysops logs, Linear issues, conversation exports, plans, and more. Use for long-term memory and archived knowledge that isn't in the live floatty outline. QMD uses hybrid search (BM25 + vector + LLM query expansion).",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Natural language search query — QMD auto-expands into keyword + semantic + hypothetical document searches",
      ),
    collections: z
      .array(z.string())
      .optional()
      .describe(
        "Filter to specific collections. Available: rangle-weekly, bbs-daily, sysops-log, linear-issues, floatty-docs, floatty-loop, claude-plans, desktop-exports, consciousness-tech, field-notes, recon, claude-skills. Omit to search all.",
      ),
    limit: z
      .number()
      .min(1)
      .max(20)
      .optional()
      .describe("Max results (default 10)"),
  }),
  execute: async ({ query, collections, limit }) => {
    try {
      const results = await qmdQuery(query, {
        collections,
        limit: limit ?? 10,
      });

      return {
        total: results.length,
        results: results.map((r) => ({
          docid: r.docid,
          score: Math.round(r.score * 100) / 100,
          file: r.file,
          title: r.title,
          snippet: r.snippet?.slice(0, 500) ?? "",
        })),
      };
    } catch (error) {
      return {
        error: `QMD search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

export const qmdGet = tool({
  description:
    "Retrieve a full document from QMD by docid (e.g., '#115e79') or file path (e.g., 'qmd://rangle-weekly/meetings/2026-03-23-sync.md'). Use after qmd_search to read the full content of a result.",
  inputSchema: z.object({
    ref: z
      .string()
      .describe(
        "Document reference — either a #docid from search results or a qmd:// file path",
      ),
    lines: z
      .number()
      .optional()
      .describe("Max lines to return (default: full document)"),
  }),
  execute: async ({ ref, lines }) => {
    try {
      const { execFileSync } = await import("child_process");
      const args = ["get", ref];
      if (lines) args.push("-l", String(lines));
      const out = execFileSync("qmd", args, {
        encoding: "utf-8",
        timeout: 15000,
      });
      return { content: out.slice(0, 8000) };
    } catch (error) {
      return {
        error: `QMD get failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

// =============================================================================
// Skills — progressive disclosure of ~/.claude/skills via bash-tool
// =============================================================================

const SKILL_DIRS = [
  join(homedir(), ".claude", "skills"),
  join(homedir(), ".agent", "skills"),
].filter((d) => existsSync(d));

async function initSkillTool() {
  for (const dir of SKILL_DIRS) {
    try {
      const toolkit = await createSkillTool({ skillsDirectory: dir });
      if (toolkit.skills.length > 0) {
        return toolkit;
      }
    } catch {
      // Skip dirs that fail
    }
  }
  return null;
}

// =============================================================================
// All tools (exported as a single record for streamText)
// =============================================================================

const baseTools = {
  web_search: webSearch,
  get_weather: getWeather,
  get_hacker_news: getHackerNewsTop,
  get_github_repo: getGitHubRepo,
  get_crypto_price: getCryptoPrice,
  floatty_search: floattySearch,
  floatty_page: floattyPage,
  floatty_search_pages: floattySearchPages,
  floatty_daily: floattyDaily,
  floatty_daily_add: floattyDailyAdd,
  floatty_block_create: floattyBlockCreate,
  floatty_presence: floattyPresence,
  floatty_markers: floattyMarkers,
  floatty_backlinks: floattyBacklinks,
  floatty_block_context: floattyBlockContext,
  floatty_stats: floattyStats,
  floatty_search_advanced: floattySearchAdvanced,
  floatty_connections: floattyConnections,
  qmd_search: qmdSearch,
  qmd_get: qmdGet,
};

/** Initialize tools — discovers skills at startup */
export async function initTools() {
  const skillToolkit = await initSkillTool();
  if (skillToolkit) {
    console.error(
      `Discovered ${skillToolkit.skills.length} skills from ${SKILL_DIRS.join(", ")}`,
    );
    return {
      ...baseTools,
      load_skill: skillToolkit.skill,
    };
  }
  return baseTools;
}

// Sync export for backward compat (no skills)
export const tools = baseTools;
