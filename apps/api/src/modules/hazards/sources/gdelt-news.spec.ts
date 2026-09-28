import type { Hazard } from '../hazard.types';
import { gdeltUrl, parseGdeltResponse, parseSeenDate, placeQueryFromHazard } from './gdelt-news';

const RESPONSE = JSON.stringify({
  articles: [
    {
      url: 'https://www.example.com/news/tema-port',
      title: 'Tema port reopens after storm',
      seendate: '20260928T101500Z',
      domain: 'example.com',
      sourcecountry: 'Ghana',
    },
    // Same story, same outlet: syndicated duplicate.
    {
      url: 'https://www.example.com/news/tema-port-2',
      title: 'Tema port reopens after storm',
      seendate: '20260928T101500Z',
      domain: 'example.com',
    },
    { url: 'javascript:alert(1)', title: 'Hostile link' },
    { url: 'ftp://files.example.com/x', title: 'Not a web link' },
    { url: 'https://other.example.org/a', title: '<b>Road closed</b>', seendate: 'garbage' },
  ],
});

describe('GDELT news', () => {
  it('keeps only http(s) articles, de-duplicates, and cleans titles', () => {
    const articles = parseGdeltResponse(RESPONSE);
    expect(articles).toEqual([
      {
        title: 'Tema port reopens after storm',
        url: 'https://www.example.com/news/tema-port',
        domain: 'example.com',
        publishedAt: '2026-09-28T10:15:00.000Z',
        sourceCountry: 'Ghana',
      },
      {
        title: 'b Road closed /b',
        url: 'https://other.example.org/a',
        domain: 'other.example.org',
        publishedAt: null,
        sourceCountry: null,
      },
    ]);
  });

  it('treats an empty body or {} as no results', () => {
    expect(parseGdeltResponse('')).toEqual([]);
    expect(parseGdeltResponse('{}')).toEqual([]);
  });

  it('treats a plain-text rate-limit reply as a failure', () => {
    expect(() => parseGdeltResponse('Please limit requests to one every 5 seconds')).toThrow('rate limited');
  });

  it('quotes the query as a phrase and strips characters that would break out of it', () => {
    const url = new URL(gdeltUrl('New "Orleans" (LA)'));
    expect(url.searchParams.get('query')).toBe('"New Orleans LA"');
    expect(url.searchParams.get('mode')).toBe('artlist');
    expect(url.searchParams.get('timespan')).toBe('72h');
  });

  it('parses compact GDELT dates', () => {
    expect(parseSeenDate('20260101T000000Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(parseSeenDate(42)).toBeNull();
  });

  it('derives a searchable place from an earthquake location', () => {
    const quake = { kind: 'EARTHQUAKE', title: 'x', details: { place: '12 km SSW of Tema, Ghana' } } as unknown as Hazard;
    expect(placeQueryFromHazard(quake)).toBe('Tema, Ghana');
    const fire = { kind: 'FIRE', title: 'Active fire', details: {} } as unknown as Hazard;
    expect(placeQueryFromHazard(fire)).toBeNull();
  });
});
