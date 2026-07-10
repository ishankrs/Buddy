import * as vscode from 'vscode';
import { getApiKey } from '../llm/secrets';
import { extractDdgRedirectUrl, htmlToText, parseDuckDuckGoResults, stripHtml } from './webParsing';

export type WebSearchProvider =
  | 'auto'
  | 'duckduckgo'
  | 'serper'
  | 'brave'
  | 'google'
  | 'tavily';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

let extensionContext: vscode.ExtensionContext | undefined;

export function setWebToolsContext(context: vscode.ExtensionContext): void {
  extensionContext = context;
}

function getConfig() {
  return vscode.workspace.getConfiguration('buddy');
}

function isWebSearchEnabled(): boolean {
  return getConfig().get<boolean>('webSearch.enabled', true);
}

async function resolveProvider(): Promise<WebSearchProvider> {
  const configured = getConfig().get<WebSearchProvider>('webSearch.provider', 'auto');
  if (configured !== 'auto') {
    return configured;
  }

  const ctx = extensionContext;
  if (!ctx) {
    return 'duckduckgo';
  }

  if (await getApiKey(ctx, 'serper')) {
    return 'serper';
  }
  if (await getApiKey(ctx, 'brave')) {
    return 'brave';
  }
  if (await getApiKey(ctx, 'tavily')) {
    return 'tavily';
  }
  if ((await getApiKey(ctx, 'google')) && getConfig().get<string>('webSearch.googleCx', '')) {
    return 'google';
  }

  return 'duckduckgo';
}

export async function searchWebTool(args: {
  query: string;
  max_results?: number;
}): Promise<string> {
  if (!isWebSearchEnabled()) {
    return JSON.stringify({
      error: 'Web search is disabled. Enable buddy.webSearch.enabled in Settings.',
    });
  }

  const query = args.query?.trim();
  if (!query) {
    return JSON.stringify({ error: 'query is required' });
  }

  const maxResults = args.max_results ?? getConfig().get<number>('webSearch.maxResults', 8);

  try {
    const provider = await resolveProvider();
    let results: SearchResult[];

    switch (provider) {
      case 'serper':
        results = await searchSerper(query, maxResults);
        break;
      case 'brave':
        results = await searchBrave(query, maxResults);
        break;
      case 'google':
        results = await searchGoogle(query, maxResults);
        break;
      case 'tavily':
        results = await searchTavily(query, maxResults);
        break;
      case 'duckduckgo':
      default:
        results = await searchDuckDuckGo(query, maxResults);
        break;
    }

    return JSON.stringify({
      provider,
      query,
      result_count: results.length,
      results,
      hint:
        results.length === 0
          ? 'Try rephrasing the query or set a Serper/Brave API key for Google-quality results (Buddy: Set Web Search API Key).'
          : 'Use fetch_url to read full pages for details.',
    });
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      query,
    });
  }
}

async function searchSerper(query: string, maxResults: number): Promise<SearchResult[]> {
  const ctx = extensionContext;
  if (!ctx) {
    throw new Error('Extension not initialized');
  }
  const apiKey = await getApiKey(ctx, 'serper');
  if (!apiKey) {
    throw new Error('Serper API key not set. Run "Buddy: Set Web Search API Key".');
  }

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: maxResults }),
  });

  if (!res.ok) {
    throw new Error(`Serper search failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };

  return (data.organic ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
  }));
}

async function searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
  const ctx = extensionContext;
  if (!ctx) {
    throw new Error('Extension not initialized');
  }
  const apiKey = await getApiKey(ctx, 'brave');
  if (!apiKey) {
    throw new Error('Brave Search API key not set. Run "Buddy: Set Web Search API Key".');
  }

  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!res.ok) {
    throw new Error(`Brave search failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };

  return (data.web?.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
  }));
}

async function searchGoogle(query: string, maxResults: number): Promise<SearchResult[]> {
  const ctx = extensionContext;
  if (!ctx) {
    throw new Error('Extension not initialized');
  }
  const apiKey = await getApiKey(ctx, 'google');
  const cx = getConfig().get<string>('webSearch.googleCx', '');
  if (!apiKey || !cx) {
    throw new Error(
      'Google Custom Search requires API key and buddy.webSearch.googleCx (Search Engine ID).'
    );
  }

  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.min(maxResults, 10)));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Google search failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    items?: Array<{ title?: string; link?: string; snippet?: string }>;
  };

  return (data.items ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
  }));
}

async function searchTavily(query: string, maxResults: number): Promise<SearchResult[]> {
  const ctx = extensionContext;
  if (!ctx) {
    throw new Error('Extension not initialized');
  }
  const apiKey = await getApiKey(ctx, 'tavily');
  if (!apiKey) {
    throw new Error('Tavily API key not set. Run "Buddy: Set Web Search API Key".');
  }

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`Tavily search failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  return (data.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 300),
  }));
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  const body = new URLSearchParams({ q: query, kl: 'us-en' });
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Buddy-VSCode-Extension/1.0',
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo search failed: ${res.status}`);
  }

  const html = await res.text();
  const results = parseDuckDuckGoResults(html, maxResults);

  if (results.length === 0) {
    const fallbackRe = /<a class="result-link" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let match: RegExpExecArray | null;
    while ((match = fallbackRe.exec(html)) !== null && results.length < maxResults) {
      results.push({
        title: stripHtml(match[2]),
        url: extractDdgRedirectUrl(match[1]),
        snippet: '',
      });
    }
  }

  return results;
}

export async function fetchUrlTool(args: {
  url: string;
  max_chars?: number;
}): Promise<string> {
  if (!isWebSearchEnabled()) {
    return JSON.stringify({ error: 'Web fetch is disabled (buddy.webSearch.enabled).' });
  }

  const rawUrl = args.url?.trim();
  if (!rawUrl) {
    return JSON.stringify({ error: 'url is required' });
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return JSON.stringify({ error: `Invalid URL: ${rawUrl}` });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return JSON.stringify({ error: 'Only http and https URLs are allowed' });
  }

  const maxChars = args.max_chars ?? getConfig().get<number>('webSearch.fetchMaxChars', 12000);

  try {
    const res = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Buddy-VSCode-Extension/1.0',
        Accept: 'text/html,application/json,text/plain,*/*',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return JSON.stringify({
        error: `HTTP ${res.status} ${res.statusText}`,
        url: parsed.toString(),
      });
    }

    const contentType = res.headers.get('content-type') ?? '';
    let text = await res.text();

    if (contentType.includes('html')) {
      text = htmlToText(text);
    }

    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars]`;
    }

    return JSON.stringify({
      url: parsed.toString(),
      content_type: contentType,
      content: text,
    });
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      url: parsed.toString(),
    });
  }
}

