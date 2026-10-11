// Tiny, bounded Atom/RSS subset parser. It does not resolve external XML entities.
// Minimal structural checks prevent an incomplete 200 OK response from advancing
// the D1 scan cursor as if no new items existed. This is not a general XML validator.
export function entries(xml: string, tag: 'entry' | 'item'): string[] {
  // Avoid treating tag-like text in comments or CDATA as actual XML structure.
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  const structure = withoutComments.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const root = /<((?:[a-zA-Z_][\w.-]*:)?(?:feed|rss))(?=\s|>)/i.exec(structure);
  if (!root) throw new Error('Invalid XML feed root');
  const rootClosing = new RegExp('</' + root[1] + '\\s*>', 'i');
  if (!rootClosing.test(structure)) throw new Error('Truncated XML feed: missing closing root');
  const pattern = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'gi');
  const found = [...withoutComments.matchAll(pattern)].map((match) => match[1] ?? '');
  const openingPattern = new RegExp('<' + tag + '(?=\\s|>)', 'gi');
  const closingPattern = new RegExp('<\\/' + tag + '\\s*>', 'gi');
  const opens = [...structure.matchAll(openingPattern)].length;
  const closes = [...structure.matchAll(closingPattern)].length;
  if (opens !== closes || opens !== found.length) {
    throw new Error('Malformed or truncated XML feed entries');
  }
  return found;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#(?:x[0-9a-fA-F]+|[0-9]+)|amp|lt|gt|quot|apos);/g, (entity, value: string) => {
    switch (value) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
    }
    const code = value[1]?.toLowerCase() === 'x'
      ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : entity;
  });
}

export function tagText(xml: string, tag: string): string | null {
  // All tag names are internal constants; never pass a user-provided regex.
  const pattern = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'i');
  const match = pattern.exec(xml);
  if (!match) return null;
  const content = (match[1] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(content.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

export function requiredText(xml: string, tag: string): string {
  const value = tagText(xml, tag);
  if (!value) throw new Error('Missing or empty feed field: ' + tag);
  return value;
}

export function parseDate(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid feed publication date');
  return timestamp;
}

export async function fetchTextBounded(
  url: URL, source: string, fetcher: typeof fetch = fetch, maxBytes = 512 * 1024,
): Promise<string> {
  const response = await fetcher(url, {
    headers: { Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(source + ' HTTP ' + response.status);
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) { await response.body?.cancel(); throw new Error(source + ' response too large'); }
  if (!response.body) throw new Error(source + ' empty response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let result = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error(source + ' response too large'); }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } finally { reader.releaseLock(); }
}
