/** PTYs en tránsito entre ventanas: evita que Terminal los mate al desmontarse. */
const transferring = new Set<number>();

export function markPtyTransferring(ptyId: number): void {
  transferring.add(ptyId);
}

/** Consume la marca (una sola vez) y dice si este ptyId se estaba transfiriendo. */
export function consumePtyTransferring(ptyId: number): boolean {
  if (transferring.has(ptyId)) {
    transferring.delete(ptyId);
    return true;
  }
  return false;
}
