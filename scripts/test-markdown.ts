import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderInlineText, renderMarkdownBlock } from "../src/messageMarkdown";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function html(node: ReactNode) {
  return renderToStaticMarkup(node as ReactElement);
}

// Headings, lists, blockquote, and paragraphs group correctly from raw
// Codex output, and code spans inside list items still work.
const sample = [
  "## Текущее состояние",
  "",
  "- Все 5 systemd-сервисов активны.",
  "- Сайт отвечает `200`.",
  "",
  "1. Админка нарушает production-модель.",
  "",
  "> Это архитектурная проблема."
].join("\n");

const blocks = renderMarkdownBlock(sample, "t", false);
const rendered = html(blocks as ReactNode);

assert(rendered.includes("<h5") && rendered.includes("Текущее состояние"), "## heading did not render as a heading element");
assert(!rendered.includes("##"), "literal ## leaked into the rendered output");
assert(rendered.includes("<ul") && rendered.includes("<li"), "unordered list did not render as ul/li");
assert((rendered.match(/<li/g) ?? []).length === 3, "total list item count is wrong (2 unordered + 1 ordered)");
assert(rendered.includes("<ol") && rendered.includes("Админка нарушает"), "ordered list did not render as ol/li");
assert(rendered.includes("<code") && rendered.includes("200"), "inline code inside a list item was lost");
assert(rendered.includes("<blockquote"), "blockquote did not render as a blockquote element");

// Inline formatting: bold, italic (both * and _), code, and [label](path)
// file references, without letting markdown control real HTML.
const inline = html(renderInlineText("**жирный** и *курсив* и _ещё курсив_, `code`, [f.ts](src/f.ts)", "i") as unknown as ReactNode);
assert(inline.includes("<strong>жирный</strong>"), "bold did not render");
assert(inline.includes("<em>курсив</em>"), "*italic* did not render");
assert(inline.includes("<em>ещё курсив</em>"), "_italic_ did not render");
assert(inline.includes("<code") && inline.includes("code</code>"), "inline code did not render");
assert(inline.includes("file-reference") && inline.includes("f.ts"), "[label](path) file reference did not render");

// snake_case identifiers must not be misread as _italic_.
const snakeCase = html(renderInlineText("значение task_queue_id внутри текста", "s") as unknown as ReactNode);
assert(!snakeCase.includes("<em>"), "underscore inside an identifier was misparsed as italic");
assert(snakeCase.includes("task_queue_id"), "identifier text was altered");

// A markdown special character with no matching pair renders as plain text,
// not as broken markup or a dropped character.
const unmatched = html(renderInlineText("цена * 2 = X", "u") as unknown as ReactNode);
assert(unmatched.includes("цена * 2 = X"), "unmatched * corrupted plain text");

console.log("markdown rendering: ok");
