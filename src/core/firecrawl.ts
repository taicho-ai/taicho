/** Firecrawl scrape client: turn a URL into clean markdown. Used by the read_url agent tool so the
 *  model can read MCP setup docs. fetch is injectable for tests; the API key comes from the env only. */
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";

export async function scrapeUrl(
  url: string,
  opts: { apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ markdown: string } | { error: string }> {
  const apiKey = opts.apiKey ?? process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return { error: "FIRECRAWL_API_KEY is not set — set it to let agents read web pages." };
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    if (!res.ok) return { error: `firecrawl ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const json = (await res.json()) as { data?: { markdown?: string } };
    const markdown = json.data?.markdown;
    return markdown ? { markdown } : { error: "firecrawl returned no markdown for this page" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
