export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractDdgRedirectUrl(href: string): string {
  try {
    if (href.startsWith('//duckduckgo.com/l/?')) {
      const u = new URL(`https:${href}`);
      const uddg = u.searchParams.get('uddg');
      if (uddg) {
        return decodeURIComponent(uddg);
      }
    }
    return href;
  } catch {
    return href;
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseDuckDuckGoResults(
  html: string,
  maxResults: number
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const linkRe =
    /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<td class="result-snippet"[^>]*>([\s\S]*?)<\/td>)/g;

  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null && results.length < maxResults) {
    const rawUrl = decodeURIComponent(match[1].replace(/&amp;/g, '&'));
    const url = extractDdgRedirectUrl(rawUrl);
    const title = stripHtml(match[2]);
    const snippet = stripHtml(match[3] || match[4] || '');
    if (url && title) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}
