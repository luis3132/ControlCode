/**
 * De eventos a conversación. Puro: el historial cargado del `.jsonl` y el stream de un turno
 * pasan por acá igual, así que lo que se ve al volver a abrir la tab es lo mismo que se vio
 * mientras corría.
 */
import type { ChatEvent, ChatItem, ChatState } from "./types";

type Tool = Extract<ChatItem, { kind: "tool" }>;

/** La tarjeta de una herramienta, en la conversación o adentro de un subagente. */
function findTool(items: ChatItem[], toolUseId: string): Tool | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== "tool") continue;
    if (item.toolUseId === toolUseId) return item;
    const inner = findTool(item.children, toolUseId);
    if (inner) return inner;
  }
  return null;
}

/** Reemplaza una herramienta (por id de llamada) donde esté, sin mutar nada. */
function replaceTool(items: ChatItem[], toolUseId: string, update: (t: Tool) => Tool): ChatItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (changed || item.kind !== "tool") return item;
    if (item.toolUseId === toolUseId) {
      changed = true;
      return update(item);
    }
    const children = replaceTool(item.children, toolUseId, update);
    if (children !== item.children) {
      changed = true;
      return { ...item, children };
    }
    return item;
  });
  return changed ? next : items;
}

/** Agrega `item` a la conversación o, si es de un subagente, adentro de su `Task`. */
function place(state: ChatState, parent: string | null, make: (id: number) => ChatItem): ChatState {
  const item = make(state.nextId);
  const nextId = state.nextId + 1;
  if (parent && findTool(state.items, parent)) {
    return {
      ...state,
      nextId,
      items: replaceTool(state.items, parent, (t) => ({ ...t, children: [...t.children, item] })),
    };
  }
  return { ...state, nextId, items: [...state.items, item] };
}

/** Lo último, si es texto (o thinking) que se está escribiendo. */
function streamingTail(items: ChatItem[], kind: "text" | "thinking") {
  const last = items[items.length - 1];
  return last && last.kind === kind && last.streaming ? last : null;
}

function appendDelta(state: ChatState, kind: "text" | "thinking", text: string): ChatState {
  const tail = streamingTail(state.items, kind);
  if (tail) {
    return { ...state, items: [...state.items.slice(0, -1), { ...tail, text: tail.text + text }] };
  }
  return {
    ...state,
    nextId: state.nextId + 1,
    items: [...state.items, { kind, id: state.nextId, text, streaming: true }],
  };
}

/** El bloque entero llegó: reemplaza al que se venía escribiendo, o se agrega. */
function settle(state: ChatState, kind: "text" | "thinking", text: string, parent: string | null): ChatState {
  if (!parent) {
    const tail = streamingTail(state.items, kind);
    if (tail) {
      return { ...state, items: [...state.items.slice(0, -1), { ...tail, text, streaming: false }] };
    }
  }
  return place(state, parent, (id) => ({ kind, id, text, streaming: false }));
}

/** Lo que se estaba escribiendo y no llegó entero (el turno se cortó) queda como está. */
export function settleStreaming(state: ChatState): ChatState {
  if (!state.items.some((i) => (i.kind === "text" || i.kind === "thinking") && i.streaming)) return state;
  return {
    ...state,
    items: state.items.map((i) =>
      (i.kind === "text" || i.kind === "thinking") && i.streaming ? { ...i, streaming: false } : i
    ),
  };
}

export function reduceChat(state: ChatState, event: ChatEvent): ChatState {
  switch (event.kind) {
    case "init":
      return {
        ...state,
        info: {
          model: event.model,
          permissionMode: event.permissionMode,
          slashCommands: event.slashCommands,
          terminalCommands: event.terminalCommands,
        },
      };
    case "status":
      return { ...state, status: event.status };
    case "retry":
      return { ...state, status: `retry:${event.attempt ?? "?"}/${event.maxRetries ?? "?"}` };
    case "textDelta":
      // Los de un subagente no se dibujan de a letra: su texto entero llega igual.
      return event.parent ? state : appendDelta(state, "text", event.text);
    case "thinkingDelta":
      return event.parent ? state : appendDelta(state, "thinking", event.text);
    case "text":
      return settle(state, "text", event.text, event.parent);
    case "thinking":
      return settle(state, "thinking", event.text, event.parent);
    case "toolStart": {
      if (findTool(state.items, event.id)) return state;
      return place(settleStreaming(state), event.parent, (id) => ({
        kind: "tool", id, toolUseId: event.id, name: event.name, label: event.name,
        input: null, result: null, children: [],
      }));
    }
    case "toolUse": {
      if (findTool(state.items, event.id)) {
        return {
          ...state,
          items: replaceTool(state.items, event.id, (t) => ({ ...t, input: event.input, label: event.label })),
        };
      }
      return place(settleStreaming(state), event.parent, (id) => ({
        kind: "tool", id, toolUseId: event.id, name: event.name, label: event.label,
        input: event.input, result: null, children: [],
      }));
    }
    case "toolResult": {
      const result = {
        content: event.content, isError: event.isError, images: event.images, truncated: event.truncated,
      };
      if (!findTool(state.items, event.toolUseId)) return state;
      return { ...state, items: replaceTool(state.items, event.toolUseId, (t) => ({ ...t, result })) };
    }
    case "user":
      return place(settleStreaming(state), null, (id) => ({ kind: "user", id, text: event.text, images: event.images }));
    case "command":
      return place(state, null, (id) => ({ kind: "command", id, name: event.name, args: event.args, output: null }));
    case "commandOutput": {
      const last = state.items[state.items.length - 1];
      if (last?.kind === "command" && last.output === null) {
        return { ...state, items: [...state.items.slice(0, -1), { ...last, output: event.text }] };
      }
      return place(state, null, (id) => ({ kind: "notice", id, tone: "info", text: event.text }));
    }
    case "compacted":
      return place(state, null, (id) => ({ kind: "compacted", id, summary: null }));
    case "summary": {
      const at = state.items.map((i) => i.kind).lastIndexOf("compacted");
      const target = at >= 0 ? state.items[at] : undefined;
      if (target?.kind === "compacted" && target.summary === null) {
        const items = [...state.items];
        items[at] = { ...target, summary: event.text };
        return { ...state, items };
      }
      return place(state, null, (id) => ({ kind: "compacted", id, summary: event.text }));
    }
    case "result":
      return place({ ...settleStreaming(state), status: null }, null, (id) => ({
        kind: "result", id, ok: event.ok, error: event.error, costUsd: event.costUsd,
        tokensIn: event.tokensIn, tokensOut: event.tokensOut, durationMs: event.durationMs,
      }));
  }
}

export const reduceAll = (state: ChatState, events: ChatEvent[]) => events.reduce(reduceChat, state);

/** Agrega un aviso de la app (no del agente): un error al lanzar, un turno parado. */
export function addNotice(state: ChatState, tone: "info" | "error", text: string): ChatState {
  return place(settleStreaming(state), null, (id) => ({ kind: "notice", id, tone, text }));
}

/** El mensaje que la persona acaba de mandar: el stream no lo repite. */
export function addUser(state: ChatState, text: string, images: number): ChatState {
  return place(settleStreaming(state), null, (id) => ({ kind: "user", id, text, images }));
}

/** Las herramientas que siguen sin resultado: el turno terminó y no van a tenerlo. */
export function unfinishedTools(items: ChatItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind !== "tool") continue;
    if (!item.result) out.push(item.toolUseId);
    out.push(...unfinishedTools(item.children));
  }
  return out;
}
