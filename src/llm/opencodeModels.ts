// Live OpenCode Zen model catalog.
//
// No hardcoded model suggestions: the picker fetches the current list from
// https://opencode.ai/zen/v1/models at selection time. Pricing is not part of
// that response, so free vs paid is derived with a documented rule instead of
// an ID list: Zen marks no-charge models with a `-free` suffix, plus the
// `big-pickle` stealth model which Zen lists as free.
//
// This module is intentionally free of `vscode` imports so it stays unit
// testable under plain node.

export const OPENCODE_ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';

export const OPENCODE_ZEN_DOCS_URL = 'https://opencode.ai/docs/zen';

export interface OpencodeModelInfo {
  id: string;
  /** No-charge model: works with just an API key, no payment needed. */
  free: boolean;
}

export interface GroupedOpencodeModels {
  free: OpencodeModelInfo[];
  paid: OpencodeModelInfo[];
}

/** Free = `-free` suffixed IDs plus the `big-pickle` stealth model. */
export function isFreeOpencodeModel(id: string): boolean {
  return id === 'big-pickle' || id.endsWith('-free');
}

/** Parse a `GET /zen/v1/models` body (`{ data: [{ id }] }`) into model IDs. */
export function parseOpencodeModelsResponse(json: unknown): string[] {
  if (!json || typeof json !== 'object') {
    return [];
  }
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of data) {
    if (entry && typeof entry === 'object') {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && id.trim()) {
        ids.push(id.trim());
      }
    }
  }
  return ids;
}

/**
 * Dedupe, classify, and sort: FREE models first (alphabetical), then paid
 * models (alphabetical). Paid = billed by opencode.ai.
 */
export function groupOpencodeModels(ids: string[]): GroupedOpencodeModels {
  const seen = new Set<string>();
  const free: OpencodeModelInfo[] = [];
  const paid: OpencodeModelInfo[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const info = { id, free: isFreeOpencodeModel(id) };
    (info.free ? free : paid).push(info);
  }
  free.sort((a, b) => a.id.localeCompare(b.id));
  paid.sort((a, b) => a.id.localeCompare(b.id));
  return { free, paid };
}

/** Flat list in display order: free first, then paid. */
export function sortOpencodeModels(ids: string[]): OpencodeModelInfo[] {
  const { free, paid } = groupOpencodeModels(ids);
  return [...free, ...paid];
}

/**
 * Derive the catalog URL from the configured chat base URL: a trailing
 * `/chat/completions` is swapped for a sibling `/models` on the same host
 * (OpenAI list convention); an explicit `.../models` URL is used as-is.
 * Anything else falls back to the canonical Zen catalog URL.
 */
export function resolveOpencodeModelsUrl(baseUrl?: string): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (trimmed) {
    try {
      const url = new URL(trimmed);
      if (/\/chat\/completions$/.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/chat\/completions$/, '/models');
        return url.toString().replace(/\/+$/, '');
      }
      if (/\/models$/.test(url.pathname)) {
        return url.toString().replace(/\/+$/, '');
      }
    } catch {
      // fall through to canonical URL
    }
  }
  return OPENCODE_ZEN_MODELS_URL;
}

export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface ModelsCache {
  at: number;
  models: OpencodeModelInfo[];
}

let cache: ModelsCache | undefined;
const CACHE_TTL_MS = 60 * 60 * 1000;

export function clearOpencodeModelsCache(): void {
  cache = undefined;
}

export interface FetchOpencodeModelsOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Skip the in-memory cache (used for manual refresh). */
  refresh?: boolean;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

/**
 * Fetch the live Zen catalog. Throws with a human-readable message on
 * network/HTTP/parse failures so callers can offer retry/manual entry.
 */
export async function fetchOpencodeModels(
  options: FetchOpencodeModelsOptions = {}
): Promise<OpencodeModelInfo[]> {
  if (cache && !options.refresh && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.models;
  }
  const url = resolveOpencodeModelsUrl(options.baseUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.apiKey?.trim()) {
    headers.Authorization = `Bearer ${options.apiKey.trim()}`;
  }
  const doFetch: FetchFn =
    options.fetchFn ??
    ((fetchUrl, init) =>
      fetch(fetchUrl, {
        headers: init?.headers,
        signal: init?.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15000),
      }) as Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>);
  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    res = await doFetch(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    });
  } catch (err) {
    throw new Error(
      `Could not reach the OpenCode Zen model list (${url}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    throw new Error(`OpenCode Zen model list returned HTTP ${res.status}.`);
  }
  const ids = parseOpencodeModelsResponse(await res.json());
  if (ids.length === 0) {
    throw new Error('OpenCode Zen returned an empty model list.');
  }
  const models = sortOpencodeModels(ids);
  cache = { at: Date.now(), models };
  return models;
}
