import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractDdgRedirectUrl,
  htmlToText,
  parseDuckDuckGoResults,
  stripHtml,
} from '../../src/tools/webParsing';

describe('stripHtml', () => {
  it('removes tags and decodes common entities', () => {
    assert.equal(stripHtml('<b>Hello</b> &amp; <i>world</i>'), 'Hello & world');
  });
});

describe('extractDdgRedirectUrl', () => {
  it('unwraps DuckDuckGo redirect links', () => {
    const href =
      '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc';
    assert.equal(extractDdgRedirectUrl(href), 'https://example.com/docs');
  });

  it('returns the original href when not a redirect', () => {
    assert.equal(extractDdgRedirectUrl('https://example.com'), 'https://example.com');
  });
});

describe('htmlToText', () => {
  it('strips scripts, styles, and collapses whitespace', () => {
    const text = htmlToText(`
      <html>
        <script>alert(1)</script>
        <style>.x{}</style>
        <nav>skip</nav>
        <p>Hello&nbsp;world</p>
      </html>
    `);
    assert.match(text, /Hello world/);
    assert.doesNotMatch(text, /alert/);
    assert.doesNotMatch(text, /skip/);
  });
});

describe('parseDuckDuckGoResults', () => {
  it('parses primary result markup', () => {
    const html = `
      <a rel="nofollow" class="result__a" href="https://example.com/page">Example Title</a>
      <a class="result__snippet">A helpful snippet</a>
    `;
    const results = parseDuckDuckGoResults(html, 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Example Title');
    assert.equal(results[0].url, 'https://example.com/page');
    assert.equal(results[0].snippet, 'A helpful snippet');
  });

  it('respects maxResults', () => {
    const html = `
      <a rel="nofollow" class="result__a" href="https://a.test">A</a><a class="result__snippet">sa</a>
      <a rel="nofollow" class="result__a" href="https://b.test">B</a><a class="result__snippet">sb</a>
      <a rel="nofollow" class="result__a" href="https://c.test">C</a><a class="result__snippet">sc</a>
    `;
    assert.equal(parseDuckDuckGoResults(html, 2).length, 2);
  });
});
