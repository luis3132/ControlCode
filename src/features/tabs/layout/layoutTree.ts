/**
 * La pantalla dividida del área de tabs, como los grupos de editores de VS Code.
 *
 * Un workspace tiene un árbol: las hojas son GRUPOS —cada uno con sus tabs y la que se ve—
 * y los nodos internos son DIVISIONES en fila (lado a lado) o en columna (una arriba de la
 * otra), con el tamaño de cada parte. Sin dividir, el árbol es un solo grupo y todo se ve
 * como siempre.
 *
 * Las tabs se nombran con una clave (`a:<id>` un agente, `v:<id>` un archivo, diff o
 * navegador) y no se copian entre grupos: una terminal tiene UN proceso, no se puede
 * mostrar en dos lados. Dividir y arrastrar MUEVEN.
 *
 * Lógica pura e inmutable, probada en `tests/layoutTree.test.ts`; el store la usa.
 */

export interface GroupNode {
  kind: "group";
  id: string;
  /** Las tabs del grupo, en el orden de su tira. */
  items: string[];
  /** La que se ve. `null` solo en un grupo vacío. */
  active: string | null;
  /** Se creó vacío al dividir: se queda aunque no tenga tabs, para arrastrarle una o abrir
   *  algo ahí. Uno que se vacía porque se cerraron o movieron sus tabs, desaparece. */
  keepEmpty?: boolean;
}

export interface SplitNode {
  kind: "split";
  id: string;
  /** `row`: lado a lado (divisor vertical). `column`: una arriba de la otra. */
  direction: "row" | "column";
  children: LayoutNode[];
  /** Fracción de cada hijo, suman 1. */
  sizes: number[];
}

export type LayoutNode = GroupNode | SplitNode;

export interface WorkspaceLayout {
  root: LayoutNode;
  /** El grupo donde se está trabajando: ahí caen las tabs nuevas. */
  focused: string;
}

export type SplitSide = "right" | "left" | "down" | "up";

export const agentKey = (tabId: string) => `a:${tabId}`;
export const viewKey = (viewId: string) => `v:${viewId}`;
export const isAgentKey = (key: string) => key.startsWith("a:");
export const keyId = (key: string) => key.slice(2);

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export function createLayout(items: string[] = []): WorkspaceLayout {
  const group: GroupNode = { kind: "group", id: newId(), items: [...items], active: items[0] ?? null };
  return { root: group, focused: group.id };
}

/** Los grupos en orden de pantalla: de izquierda a derecha y de arriba a abajo. */
export function allGroups(node: LayoutNode): GroupNode[] {
  return node.kind === "group" ? [node] : node.children.flatMap(allGroups);
}

export function findGroup(layout: WorkspaceLayout, groupId: string): GroupNode | undefined {
  return allGroups(layout.root).find((g) => g.id === groupId);
}

export function groupOf(layout: WorkspaceLayout, key: string): GroupNode | undefined {
  return allGroups(layout.root).find((g) => g.items.includes(key));
}

function mapGroups(node: LayoutNode, fn: (g: GroupNode) => GroupNode): LayoutNode {
  if (node.kind === "group") return fn(node);
  return { ...node, children: node.children.map((c) => mapGroups(c, fn)) };
}

/** Saca un grupo del árbol, repartiendo su lugar entre sus hermanos. */
function removeGroupNode(node: LayoutNode, groupId: string): LayoutNode | null {
  if (node.kind === "group") return node.id === groupId ? null : node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const next = removeGroupNode(child, groupId);
    if (next) {
      children.push(next);
      sizes.push(node.sizes[i] ?? 1 / node.children.length);
    }
  });
  if (children.length === 0) return null;
  return { ...node, children, sizes };
}

/**
 * Deja el árbol en su forma más simple: una división de un solo hijo es ese hijo, una
 * división adentro de otra en la misma dirección se aplana, y los tamaños vuelven a sumar 1.
 */
export function normalize(node: LayoutNode): LayoutNode {
  if (node.kind === "group") return node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((raw, i) => {
    const child = normalize(raw);
    const size = node.sizes[i] ?? 1 / node.children.length;
    if (child.kind === "split" && child.direction === node.direction) {
      const inner = sum(child.sizes);
      child.children.forEach((grand, j) => {
        children.push(grand);
        sizes.push(size * ((child.sizes[j] ?? 0) / (inner || 1)));
      });
    } else {
      children.push(child);
      sizes.push(size);
    }
  });
  if (children.length === 1) return children[0]!;
  const total = sum(sizes) || 1;
  return { ...node, children, sizes: sizes.map((s) => s / total) };
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Dónde entra una tab nueva en un grupo: los agentes juntos al principio, lo demás al final. */
function insertItem(items: string[], key: string): string[] {
  if (!isAgentKey(key)) return [...items, key];
  let lastAgent = -1;
  items.forEach((k, i) => { if (isAgentKey(k)) lastAgent = i; });
  return [...items.slice(0, lastAgent + 1), key, ...items.slice(lastAgent + 1)];
}

/** Qué se ve en un grupo cuando se va `removed`: la vecina de la izquierda, o la de la derecha. */
function activeAfterRemoving(items: string[], removed: string, active: string | null): string | null {
  if (active !== removed) return active;
  const index = items.indexOf(removed);
  const rest = items.filter((k) => k !== removed);
  return rest[Math.max(0, index - 1)] ?? null;
}

/** La que se ve después de que se fueron algunas: la misma si sigue, o la más cercana a su
 *  izquierda, o a su derecha. */
function survivingActive(old: string[], active: string | null, alive: (key: string) => boolean): string | null {
  if (active && alive(active)) return active;
  const index = active ? old.indexOf(active) : -1;
  for (let i = index - 1; i >= 0; i--) if (alive(old[i]!)) return old[i]!;
  for (let i = index + 1; i < old.length; i++) if (alive(old[i]!)) return old[i]!;
  return old.find(alive) ?? null;
}

function withoutItem(group: GroupNode, key: string): GroupNode {
  if (!group.items.includes(key)) return group;
  return { ...group, items: group.items.filter((k) => k !== key), active: activeAfterRemoving(group.items, key, group.active) };
}

/** Saca los grupos que quedaron vacíos sin haberse creado así, y arregla el foco: si se fue
 *  el enfocado, pasa al de al lado (el de antes, o el de después), no al primero. */
function tidy(layout: WorkspaceLayout, emptied: Set<string>): WorkspaceLayout {
  const order = allGroups(layout.root).map((g) => g.id);
  let root = layout.root;
  for (const group of allGroups(root)) {
    if (group.items.length > 0 || group.keepEmpty || !emptied.has(group.id)) continue;
    if (allGroups(root).length === 1) break;
    root = removeGroupNode(root, group.id) ?? root;
  }
  root = normalize(root);
  const alive = new Set(allGroups(root).map((g) => g.id));
  if (alive.has(layout.focused)) return { root, focused: layout.focused };
  const at = order.indexOf(layout.focused);
  const before = order.slice(0, Math.max(0, at)).reverse().find((id) => alive.has(id));
  const after = order.slice(at + 1).find((id) => alive.has(id));
  return { root, focused: before ?? after ?? allGroups(root)[0]!.id };
}

/**
 * Pone el árbol al día con las tabs que existen: saca las que se cerraron y agrega al grupo
 * enfocado las que no están en ninguno (una tab recién abierta, una restaurada).
 */
export function reconcile(layout: WorkspaceLayout, present: string[]): WorkspaceLayout {
  const alive = new Set(present);
  const emptied = new Set<string>();
  let root = mapGroups(layout.root, (group) => {
    const items = group.items.filter((k) => alive.has(k));
    if (items.length === group.items.length) return group;
    if (items.length === 0) emptied.add(group.id);
    return { ...group, items, active: survivingActive(group.items, group.active, (k) => alive.has(k)) };
  });
  const assigned = new Set(allGroups(root).flatMap((g) => g.items));
  const missing = present.filter((k) => !assigned.has(k));
  let next = tidy({ root, focused: layout.focused }, emptied);
  if (missing.length === 0) return next;
  root = mapGroups(next.root, (group) => {
    if (group.id !== next.focused) return group;
    const items = missing.reduce(insertItem, group.items);
    return { ...group, items, active: group.active ?? items[0] ?? null, keepEmpty: false };
  });
  next = { ...next, root };
  return next;
}

/** Muestra `key` en su grupo y enfoca ese grupo. Si no estaba en ninguno, entra al enfocado. */
export function activate(layout: WorkspaceLayout, key: string): WorkspaceLayout {
  const owner = groupOf(layout, key) ?? findGroup(layout, layout.focused) ?? allGroups(layout.root)[0]!;
  const root = mapGroups(layout.root, (group) => {
    if (group.id !== owner.id) return group;
    const items = group.items.includes(key) ? group.items : insertItem(group.items, key);
    return { ...group, items, active: key, keepEmpty: false };
  });
  return { root, focused: owner.id };
}

export function focusGroup(layout: WorkspaceLayout, groupId: string): WorkspaceLayout {
  return findGroup(layout, groupId) ? { ...layout, focused: groupId } : layout;
}

/** Lleva `key` a otro grupo (en `index`, o al final) y lo muestra ahí. */
export function moveItem(layout: WorkspaceLayout, key: string, targetGroupId: string, index?: number): WorkspaceLayout {
  const target = findGroup(layout, targetGroupId);
  if (!target) return layout;
  const source = groupOf(layout, key);
  const emptied = new Set<string>();
  let root = mapGroups(layout.root, (group) => {
    if (group.id === targetGroupId) {
      const rest = group.items.filter((k) => k !== key);
      // El índice se cuenta sobre la tira como se ve, con la tab todavía en su lugar.
      const oldIndex = group.items.indexOf(key);
      let at = index ?? rest.length;
      if (oldIndex !== -1 && index !== undefined && oldIndex < index) at -= 1;
      at = Math.max(0, Math.min(rest.length, at));
      return { ...group, items: [...rest.slice(0, at), key, ...rest.slice(at)], active: key, keepEmpty: false };
    }
    if (group.id === source?.id) {
      const next = withoutItem(group, key);
      if (next.items.length === 0) emptied.add(group.id);
      return next;
    }
    return group;
  });
  root = normalize(root);
  return tidy({ root, focused: targetGroupId }, emptied);
}

/**
 * Divide `groupId` hacia `side`. Con `key`, esa tab se muda al grupo nuevo; si era la única
 * de su grupo —o no se pasa ninguna— el grupo nuevo nace vacío, listo para recibir una.
 */
export function split(layout: WorkspaceLayout, groupId: string, side: SplitSide, key?: string): WorkspaceLayout {
  const origin = findGroup(layout, groupId);
  if (!origin) return layout;
  const moves = key !== undefined && (!origin.items.includes(key) || origin.items.length > 1);
  const fresh: GroupNode = moves
    ? { kind: "group", id: newId(), items: [key!], active: key! }
    : { kind: "group", id: newId(), items: [], active: null, keepEmpty: true };
  const direction = side === "right" || side === "left" ? "row" : "column";
  const before = side === "left" || side === "up";
  const emptied = new Set<string>();

  // Primero la tab sale de donde estaba (su grupo, o cualquier otro si venía de afuera).
  let root = moves ? mapGroups(layout.root, (group) => {
    if (!group.items.includes(key!)) return group;
    const next = withoutItem(group, key!);
    if (next.items.length === 0 && group.id !== groupId) emptied.add(group.id);
    return next;
  }) : layout.root;

  const place = (node: LayoutNode): LayoutNode => {
    if (node.kind === "group") {
      if (node.id !== groupId) return node;
      return {
        kind: "split", id: newId(), direction,
        children: before ? [fresh, node] : [node, fresh],
        sizes: [0.5, 0.5],
      };
    }
    // Si el grupo ya está en una división de la misma dirección, el nuevo entra como
    // hermano y comparte la mitad de su lugar: dividir tres veces a la derecha da tres
    // columnas, no una columna y un árbol anidado.
    const index = node.children.findIndex((c) => c.kind === "group" && c.id === groupId);
    if (index !== -1 && node.direction === direction) {
      const size = node.sizes[index] ?? 1 / node.children.length;
      const children = [...node.children];
      const sizes = [...node.sizes];
      children.splice(before ? index : index + 1, 0, fresh);
      sizes.splice(index, 1, size / 2, size / 2);
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(place) };
  };
  root = normalize(place(root));
  return tidy({ root, focused: fresh.id }, emptied);
}

/**
 * Cierra un grupo sin cerrar sus tabs: pasan al grupo vecino (el de antes, o el de después).
 * Cerrar las tabs sería matar agentes por cerrar un panel.
 */
export function closeGroup(layout: WorkspaceLayout, groupId: string): WorkspaceLayout {
  const groups = allGroups(layout.root);
  const index = groups.findIndex((g) => g.id === groupId);
  if (index === -1 || groups.length === 1) return layout;
  const closing = groups[index]!;
  const neighbor = groups[index - 1] ?? groups[index + 1]!;
  let root = mapGroups(layout.root, (group) => {
    if (group.id !== neighbor.id) return group;
    const items = closing.items.filter((k) => !group.items.includes(k)).reduce(insertItem, group.items);
    return { ...group, items, active: group.active ?? closing.active ?? items[0] ?? null, keepEmpty: group.keepEmpty && items.length === 0 };
  });
  root = normalize(removeGroupNode(root, groupId) ?? root);
  return { root, focused: neighbor.id };
}

export function resize(layout: WorkspaceLayout, splitId: string, sizes: number[]): WorkspaceLayout {
  const total = sum(sizes) || 1;
  const apply = (node: LayoutNode): LayoutNode => {
    if (node.kind === "group") return node;
    if (node.id === splitId && sizes.length === node.children.length) {
      return { ...node, sizes: sizes.map((s) => s / total) };
    }
    return { ...node, children: node.children.map(apply) };
  };
  return { ...layout, root: apply(layout.root) };
}

/** Lo que vino de `localStorage`, si tiene la forma de un árbol; si no, `null`. */
export function parseLayout(value: unknown): WorkspaceLayout | null {
  const isNode = (n: unknown): n is LayoutNode => {
    if (!n || typeof n !== "object") return false;
    const node = n as Partial<LayoutNode>;
    if (node.kind === "group") {
      const g = node as Partial<GroupNode>;
      return typeof g.id === "string" && Array.isArray(g.items) && g.items.every((k) => typeof k === "string");
    }
    if (node.kind === "split") {
      const s = node as Partial<SplitNode>;
      return typeof s.id === "string" && (s.direction === "row" || s.direction === "column")
        && Array.isArray(s.children) && s.children.length > 0 && s.children.every(isNode)
        && Array.isArray(s.sizes) && s.sizes.length === s.children.length;
    }
    return false;
  };
  const v = value as Partial<WorkspaceLayout> | null;
  if (!v || !isNode(v.root) || typeof v.focused !== "string") return null;
  const root = normalize(v.root);
  const groups = allGroups(root);
  return { root, focused: groups.some((g) => g.id === v.focused) ? v.focused : groups[0]!.id };
}
