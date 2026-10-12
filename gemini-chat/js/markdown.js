/**
 * markdown.js — tiny, dependency-free Markdown -> HTML renderer.
 *
 * SECURITY MODEL (important):
 *   1. Every character of model output is HTML-escaped FIRST (escapeHtml).
 *   2. Formatting is applied to the already-escaped text.
 *   3. Link hrefs are checked against a protocol allow-list (javascript:, data:
 *      etc. are rejected), and every link gets rel="noopener noreferrer".
 * That means raw HTML from the model is displayed as text, never executed.
 *
 * Supports: ATX headings, fenced code blocks (with language tag), inline code,
 * bold/italic/strikethrough, ordered + unordered lists (one nesting level),
 * task lists, tables, blockquotes, horizontal rules, links, bare-URL autolinks.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Markdown = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SAFE_LINK = /^(https?:|mailto:|#|\/)/i;

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(text) {
    return escapeHtml(text);
  }

  /** Turn inline markdown (already escaped) into HTML. */
  function inline(text) {
    const codeSpans = [];

    // 1. Pull out inline code so nothing inside it gets formatted.
    let out = text.replace(/`([^`\n]+)`/g, (_, code) => {
      codeSpans.push(code);
      return `\u0000${codeSpans.length - 1}\u0000`;
    });

    // 2. Escaped-HTML-safe formatting.
    out = out
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');

    // 3. Markdown links: [text](url "optional title")
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      (m, label, url, title) => link(label, url, title));

    // 4. Bare URLs (skip anything already inside an href).
    out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+)/g,
      (m, pre, url) => pre + link(url, url));

    // 5. Restore inline code.
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) =>
      `<code class="md-inline-code">${codeSpans[Number(i)]}</code>`);

    return out;
  }

  function link(label, url, title) {
    const clean = String(url).trim();
    if (!SAFE_LINK.test(clean)) {
      // Unsafe scheme (javascript:, data:, vbscript:, ...) -> plain text.
      return escapeHtml(clean);
    }
    const t = title ? ` title="${escapeAttr(title)}"` : '';
    return `<a href="${escapeAttr(clean)}"${t} target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function isTableDivider(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
  }

  function splitRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  }

  function renderList(items, ordered, start) {
    const tag = ordered ? 'ol' : 'ul';
    const attrs = ordered && start !== 1 ? ` start="${start}"` : '';
    const body = items.map((item) => `<li>${renderItem(item)}</li>`).join('');
    return `<${tag}${attrs}>${body}</${tag}>`;
  }

  /** One list item: task-list checkbox, or plain inline markdown. */
  function renderItem(text) {
    const task = String(text).match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
      return `<span class="md-task"><input type="checkbox" disabled${checked}> ${inline(task[2])}</span>`;
    }
    return inline(text);
  }

  /**
   * Render a markdown string to an HTML string.
   * @param {string} src
   * @returns {string} HTML
   */
  function render(src) {
    if (src == null) return '';
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // --- fenced code block -------------------------------------------------
      const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/);
      if (fence) {
        const marker = fence[1];
        const lang = fence[2] || '';
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp(`^\\s*${marker}`).test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // skip closing fence (or EOF)
        const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
        html.push(
          '<div class="code-block">' +
            `<div class="code-head">${langLabel || '<span class="code-lang">code</span>'}` +
            '<button type="button" class="copy-code" data-copy="code">Copy</button></div>' +
            `<pre><code${lang ? ` class="language-${escapeAttr(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>` +
          '</div>'
        );
        continue;
      }

      // --- blank line --------------------------------------------------------
      if (line.trim() === '') { i++; continue; }

      // --- horizontal rule ---------------------------------------------------
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        html.push('<hr>');
        i++;
        continue;
      }

      // --- heading -----------------------------------------------------------
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        html.push(`<h${level}>${inline(escapeHtml(heading[2].trim()))}</h${level}>`);
        i++;
        continue;
      }

      // --- table -------------------------------------------------------------
      if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
        const header = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          rows.push(splitRow(lines[i]));
          i++;
        }
        const thead = '<tr>' + header.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('') + '</tr>';
        const tbody = rows
          .map((r) => '<tr>' + r.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('') + '</tr>')
          .join('');
        html.push(`<div class="table-wrap"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`);
        continue;
      }

      // --- blockquote --------------------------------------------------------
      if (/^\s{0,3}>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i++;
        }
        html.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }

      // --- lists (with one level of nesting) ---------------------------------
      const ulMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
      const olMatch = line.match(/^(\s*)(\d{1,9})[.)]\s+(.*)$/);
      if (ulMatch || olMatch) {
        const ordered = Boolean(olMatch);
        const start = ordered ? Number(olMatch[2]) : 1;
        const items = [];
        let current = null;
        let child = null;
        const pushItem = () => {
          if (current === null) return;
          items.push(child && child.length ? `${current}\u0001${child.join('\u0001')}` : current);
          current = null;
          child = null;
        };
        while (i < lines.length) {
          const l = lines[i];
          const um = l.match(/^(\s*)([-*+])\s+(.*)$/);
          const om = l.match(/^(\s*)(\d{1,9})[.)]\s+(.*)$/);
          if (!um && !om) break;
          const indent = (um || om)[1].length;
          const text = (um || om)[3];
          if (indent >= 2 && current !== null) {
            (child = child || []).push(text);
          } else {
            pushItem();
            current = text;
          }
          i++;
        }
        pushItem();
        const rendered = items.map((raw) => {
          const [main, ...subs] = raw.split('\u0001');
          const nested = subs.length ? renderList(subs, /^\d{1,9}[.)]\s/.test(subs[0]), 1) : '';
          return `<li>${renderItem(main)}${nested}</li>`;
        }).join('');
        const tag = ordered ? 'ol' : 'ul';
        const attrs = ordered && start !== 1 ? ` start="${start}"` : '';
        html.push(`<${tag}${attrs}>${rendered}</${tag}>`);
        continue;
      }

      // --- paragraph (join consecutive plain lines) --------------------------
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^\s{0,3}(#{1,6})\s/.test(lines[i]) &&
        !/^\s*(```|~~~)/.test(lines[i]) &&
        !/^\s{0,3}>\s?/.test(lines[i]) &&
        !/^(\s*)([-*+])\s+/.test(lines[i]) &&
        !/^(\s*)(\d{1,9})[.)]\s+/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      html.push(`<p>${inline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`);
    }

    return html.join('');
  }

  /** Strip markdown down to readable plain text (used for copy / titles). */
  function toPlainText(src) {
    return String(src || '')
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
      .replace(/[#>*_`~]/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return { render, inline, escapeHtml, toPlainText, SAFE_LINK };
});
