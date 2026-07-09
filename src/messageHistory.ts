import type { ThreadItem, Turn } from "./types";

function normalizedUserContent(item: ThreadItem) {
  if (item.type !== "userMessage") return "";
  return (item.content ?? []).map((part) => {
    if (part.type === "text") return `text:${(part.text || "").replace(/\s+/g, " ").trim()}`;
    return JSON.stringify(part);
  }).join("|");
}

export function dedupeThreadItems(turns: Turn[]): ThreadItem[] {
  return turns.flatMap((turn, turnIndex) => {
    const nextFirstItem = turns[turnIndex + 1]?.items?.[0];
    return turn.items.filter((item, itemIndex) => {
      if (
        item.type !== "userMessage" ||
        itemIndex !== turn.items.length - 1 ||
        nextFirstItem?.type !== "userMessage"
      ) {
        return true;
      }
      const currentContent = normalizedUserContent(item);
      return !currentContent || currentContent !== normalizedUserContent(nextFirstItem);
    });
  });
}
