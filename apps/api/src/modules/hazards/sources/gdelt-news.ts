import { UpstreamError, fetchTextCapped } from '../../../common/http';
import { cleanText, safeHttpUrl } from '../hazard-severity';
import type { Hazard, NewsArticle } from '../hazard.types';

/**
 * GDELT DOC 2.0: recent news articles matching a place or keyword.
 *
 * GDELT is free and indexes the world's news in ~65 languages, but it rate-limits hard (about one
 * request per five seconds per client) and answers an over-eager caller with a plain-text scolding
 * instead of JSON. The service gates calls and caches results; this file only builds the query
 * and reads the answer defensively.
 *
 * Only the GDELT half of the reference provider was adapted. Its other half, Google News RSS, is
 * licensed for personal, non-commercial use and has no place in a commercial product.
 *
 * Adapted from God's Eye View (MIT), server/providers/regional/news.js (GDELT part only)
 */

export const GDELT_DOC_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
export const MAX_ARTICLES = 10;

export function gdeltUrl(query: string, timespan = '72h'): string {
  const params = new URLSearchParams({
    // Quoted so "New Orleans" is a phrase, not two words; quotes and backslashes inside the
    // user's text would break out of the phrase, so they are removed first.
    query: `"${sanitiseQuery(query)}"`,
    mode: 'artlist',
    format: 'json',
    maxrecords: String(MAX_ARTICLES * 2),
    sort: 'datedesc',
    timespan,
  });
  return `${GDELT_DOC_URL}?${params.toString()}`;
}

export function sanitiseQuery(query: string): string {
  return query.replace(/["\\()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * GDELT's "no results" is sometimes `{}` and sometimes an empty body; its errors are plain text.
 * Only the latter is a failure.
 */
export function parseGdeltResponse(text: string): NewsArticle[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    throw new UpstreamError('GDELT answered with text instead of JSON (rate limited?)', 'api.gdeltproject.org', null);
  }
  const rows = (payload as { articles?: unknown } | null)?.articles;
  if (!Array.isArray(rows)) return [];

  const seen = new Set<string>();
  const articles: NewsArticle[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const article = parseArticle(row);
    if (!article) continue;
    // Syndicated copies of one wire story share a title; one link per story per outlet is enough.
    const signature = `${article.title.toLowerCase()}|${article.domain}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    articles.push(article);
    if (articles.length >= MAX_ARTICLES) break;
  }
  return articles;
}

function parseArticle(row: Record<string, unknown> | null): NewsArticle | null {
  if (!row || typeof row !== 'object') return null;
  const url = safeHttpUrl(row.url);
  const title = cleanText(row.title, 180);
  if (!url || !title) return null;
  const host = new URL(url).hostname.replace(/^www\./, '');
  return {
    title,
    url,
    domain: cleanText(row.domain, 80) ?? host,
    publishedAt: parseSeenDate(row.seendate),
    sourceCountry: cleanText(row.sourcecountry, 60),
  };
}

/** GDELT dates look like `20260817T101500Z`. */
export function parseSeenDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value.trim());
  if (compact) {
    const [, y, mo, d, h, mi, s] = compact;
    const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * A searchable place name for a hazard, used when the caller gave coordinates but no words.
 * USGS places read "12 km SSW of Tema, Ghana" — the part after "of" is what newsrooms write.
 * A named storm is searched by its name. Fire clusters and weather cells have no name.
 */
export function placeQueryFromHazard(hazard: Hazard): string | null {
  if (hazard.kind === 'CYCLONE') return hazard.title;
  if (hazard.kind === 'EARTHQUAKE' && typeof hazard.details.place === 'string') {
    const place = hazard.details.place;
    const afterOf = /\bof\s+(.+)$/i.exec(place);
    return sanitiseQuery(afterOf ? afterOf[1] : place) || null;
  }
  return null;
}

export async function fetchGdeltArticles(query: string): Promise<NewsArticle[]> {
  const text = await fetchTextCapped(gdeltUrl(query), { maxBytes: 1024 * 1024, timeoutMs: 15_000 });
  return parseGdeltResponse(text);
}
