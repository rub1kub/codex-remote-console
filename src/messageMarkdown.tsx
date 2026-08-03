import type { ReactNode } from "react";
import type { ChatMessage } from "./types";

// Deliberately not HTML: every branch returns React elements so nothing from
// Codex's output can be interpreted as markup. Keep it that way — this is a
// security boundary, not just a formatting choice (see docs/project-knowledge-base.md §19).
export function renderInlineText(text: string, keyPrefix: string) {
  return text
    .split(/(`[^`\n]+`|\[[^\]\n]+\]\([^)]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|(?<![a-zA-Zа-яА-Я0-9])_[^_\n]+_(?![a-zA-Zа-яА-Я0-9]))/g)
    .map((part, index) => {
      const key = `${keyPrefix}-inline-${index}`;
      const codeMatch = part.match(/^`([^`]+)`$/);
      if (codeMatch) {
        return (
          <code key={key} className="inline-code">
            {codeMatch[1]}
          </code>
        );
      }

      const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        return (
          <span key={key} className="file-reference" title={linkMatch[2]}>
            {linkMatch[1]}
          </span>
        );
      }

      const boldMatch = part.match(/^\*\*([^*]+)\*\*$/);
      if (boldMatch) {
        return <strong key={key}>{boldMatch[1]}</strong>;
      }

      const italicMatch = part.match(/^\*([^*]+)\*$/) || part.match(/^_([^_]+)_$/);
      if (italicMatch) {
        return <em key={key}>{italicMatch[1]}</em>;
      }

      return part;
    });
}

type MarkdownLineKind = "heading" | "unordered" | "ordered" | "quote" | "text" | "blank";

function markdownLineKind(line: string): MarkdownLineKind {
  if (!line.trim()) return "blank";
  if (/^#{1,6}\s+\S/.test(line)) return "heading";
  if (/^\s*[-*]\s+\S/.test(line)) return "unordered";
  if (/^\s*\d+[.)]\s+\S/.test(line)) return "ordered";
  if (/^\s*>\s?/.test(line)) return "quote";
  return "text";
}

export function renderMarkdownBlock(text: string, keyPrefix: string, muted: boolean) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  const textClass = `message-text ${muted ? "muted" : ""}`;
  let index = 0;
  let blockIndex = 0;

  while (index < lines.length) {
    const kind = markdownLineKind(lines[index]);
    const key = `${keyPrefix}-block-${blockIndex++}`;

    if (kind === "blank") {
      index += 1;
      continue;
    }

    if (kind === "heading") {
      const match = lines[index].match(/^(#{1,6})\s+(.*)$/)!;
      const level = Math.min(match[1].length, 6);
      const HeadingTag = `h${Math.min(level + 3, 6)}` as "h4" | "h5" | "h6";
      blocks.push(
        <HeadingTag key={key} className="message-heading">
          {renderInlineText(match[2].trim(), key)}
        </HeadingTag>
      );
      index += 1;
      continue;
    }

    if (kind === "unordered" || kind === "ordered") {
      const itemPattern = kind === "unordered" ? /^\s*[-*]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
      const items: string[] = [];
      while (index < lines.length && markdownLineKind(lines[index]) === kind) {
        const itemMatch = lines[index].match(itemPattern);
        items.push(itemMatch ? itemMatch[1] : lines[index]);
        index += 1;
      }
      const ListTag = kind === "unordered" ? "ul" : "ol";
      blocks.push(
        <ListTag key={key} className="message-list">
          {items.map((item, itemIndex) => (
            <li key={`${key}-item-${itemIndex}`}>{renderInlineText(item.trim(), `${key}-${itemIndex}`)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    if (kind === "quote") {
      const quoted: string[] = [];
      while (index < lines.length && markdownLineKind(lines[index]) === "quote") {
        quoted.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={key} className="message-quote">
          {renderInlineText(quoted.join(" ").trim(), key)}
        </blockquote>
      );
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && markdownLineKind(lines[index]) === "text") {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={key} className={textClass}>
        {renderInlineText(paragraph.join(" ").trim(), key)}
      </p>
    );
  }

  return blocks;
}

export function renderTextBlocks(message: ChatMessage) {
  if (message.role === "tool") {
    return (
      <pre className={`message-code tool-output ${message.muted ? "muted" : ""}`}>
        {message.text}
      </pre>
    );
  }

  return message.text
    .split("```")
    .map((part, index) => {
      const key = `${message.id}-${index}`;
      if (!part.trim()) return null;

      if (index % 2 === 1) {
        return (
          <pre key={key} className={`message-code ${message.muted ? "muted" : ""}`}>
            {part.replace(/^[a-zA-Z0-9_+-]*\n/, "").trim()}
          </pre>
        );
      }

      return renderMarkdownBlock(part, key, Boolean(message.muted));
    })
    .flat();
}
