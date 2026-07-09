import { dedupeThreadItems } from "../src/messageHistory";
import type { Turn } from "../src/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function user(id: string, text: string) {
  return { type: "userMessage", id, content: [{ type: "text", text }] };
}

const turns: Turn[] = [
  {
    id: "turn-1",
    status: "completed",
    items: [
      user("user-1", "Первая задача"),
      { type: "agentMessage", id: "agent-1", text: "Готово" },
      user("ghost-1", "Следующая\n\nзадача")
    ]
  },
  {
    id: "turn-2",
    status: "completed",
    items: [
      user("user-2", "Следующая задача"),
      { type: "agentMessage", id: "agent-2", text: "Выполнено" }
    ]
  },
  {
    id: "turn-3",
    status: "completed",
    items: [user("ghost-2", "Еще задача")]
  },
  {
    id: "turn-4",
    status: "completed",
    items: [
      user("user-4", "Еще задача"),
      { type: "agentMessage", id: "agent-4", text: "Ответ" }
    ]
  },
  {
    id: "turn-5",
    status: "completed",
    items: [user("repeat-1", "Повтори")]
  },
  {
    id: "turn-6",
    status: "completed",
    items: [
      user("repeat-2", "Другое сообщение"),
      { type: "agentMessage", id: "agent-6", text: "Ответ" }
    ]
  }
];

const items = dedupeThreadItems(turns);
const ids = items.map((item) => item.id);

assert(!ids.includes("ghost-1"), "trailing duplicate from a completed turn was not removed");
assert(!ids.includes("ghost-2"), "user-only duplicate turn was not removed");
assert(ids.includes("user-2") && ids.includes("user-4"), "canonical user messages were removed");
assert(ids.includes("repeat-1") && ids.includes("repeat-2"), "different consecutive messages were collapsed");

console.log("message history: ok");
