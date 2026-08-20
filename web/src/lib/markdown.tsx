import type { ReactNode } from 'react';

/**
 * Minimal Markdown renderer for assistant replies.
 *
 * Covers the subset LLMs actually emit: headings, bold/italic/inline code,
 * fenced code blocks, bullet and numbered lists (one level of nesting), links
 * and paragraphs. Everything is built as React elements — never raw HTML — so
 * model output cannot inject markup.
 */

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;

  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    last = start + token.length;
    const key = `${keyPrefix}-i${i++}`;

    if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      // Only ever link out over http(s); anything else stays inert text.
      out.push(
        /^https?:\/\//i.test(href) ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        )
      );
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type ListItem = { text: string; depth: number };

const BULLET = /^(\s*)[-*•]\s+(.*)$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/;

function renderList(items: ListItem[], ordered: boolean, key: string): ReactNode {
  const Tag = ordered ? 'ol' : 'ul';
  const nodes: ReactNode[] = [];

  // Indentation width varies by model (2 or 4 spaces), so normalise each
  // nested run to start at zero rather than assuming a fixed step.
  const base = Math.min(...items.map((it) => it.depth));

  for (let i = 0; i < items.length; i++) {
    if (items[i].depth > base) continue; // consumed by its parent below
    const raw: ListItem[] = [];
    let j = i + 1;
    while (j < items.length && items[j].depth > base) {
      raw.push(items[j]);
      j++;
    }
    const childBase = raw.length ? Math.min(...raw.map((c) => c.depth)) : 0;
    const children = raw.map((c) => ({ ...c, depth: c.depth - childBase }));
    nodes.push(
      <li key={`${key}-${i}`}>
        {renderInline(items[i].text, `${key}-${i}`)}
        {children.length > 0 && renderList(children, ordered, `${key}-${i}-sub`)}
      </li>
    );
  }
  return <Tag key={key}>{nodes}</Tag>;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];

  let paragraph: string[] = [];
  let list: ListItem[] = [];
  let listOrdered = false;
  let code: string[] | null = null;
  let codeLang = '';
  let key = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={`p${key++}`}>{renderInline(paragraph.join(' '), `p${key}`)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push(renderList(list, listOrdered, `l${key++}`));
    list = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    // fenced code block
    if (line.trimStart().startsWith('```')) {
      if (code === null) {
        flushAll();
        code = [];
        codeLang = line.trim().slice(3).trim();
      } else {
        blocks.push(
          <pre key={`c${key++}`} data-lang={codeLang || undefined}>
            <code>{code.join('\n')}</code>
          </pre>
        );
        code = null;
        codeLang = '';
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const Tag = (['h3', 'h4', 'h5', 'h6'] as const)[level - 1];
      blocks.push(<Tag key={`h${key++}`}>{renderInline(heading[2], `h${key}`)}</Tag>);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushAll();
      blocks.push(<hr key={`r${key++}`} />);
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const m = (bullet || numbered)!;
      const ordered = !!numbered;
      if (list.length && ordered !== listOrdered) flushList();
      flushParagraph();
      listOrdered = ordered;
      list.push({ text: m[2], depth: Math.floor(m[1].replace(/\t/g, '  ').length / 2) });
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (code !== null) {
    blocks.push(
      <pre key={`c${key++}`}>
        <code>{code.join('\n')}</code>
      </pre>
    );
  }
  flushAll();

  return <div className="md">{blocks}</div>;
}
