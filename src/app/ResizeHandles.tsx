import { useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Direction = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

const S = 6; // grosor del handle en px

function Handle({ direction, style }: { direction: Direction; style: React.CSSProperties }) {
  const onMouseDown = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getCurrentWindow().startResizeDragging(direction as any);
  }, [direction]);

  return (
    <div
      onMouseDown={onMouseDown}
      style={{ position: "fixed", zIndex: 9999, ...style }}
    />
  );
}

export function ResizeHandles() {
  return (
    <>
      {/* Lados */}
      <Handle direction="North"     style={{ top: 0,    left: S,  right: S,  height: S, cursor: "n-resize"  }} />
      <Handle direction="South"     style={{ bottom: 0, left: S,  right: S,  height: S, cursor: "s-resize"  }} />
      <Handle direction="East"      style={{ right: 0,  top: S,   bottom: S, width:  S, cursor: "e-resize"  }} />
      <Handle direction="West"      style={{ left: 0,   top: S,   bottom: S, width:  S, cursor: "w-resize"  }} />
      {/* Esquinas */}
      <Handle direction="NorthEast" style={{ top: 0,    right: 0,  width: S, height: S, cursor: "ne-resize" }} />
      <Handle direction="NorthWest" style={{ top: 0,    left: 0,   width: S, height: S, cursor: "nw-resize" }} />
      <Handle direction="SouthEast" style={{ bottom: 0, right: 0,  width: S, height: S, cursor: "se-resize" }} />
      <Handle direction="SouthWest" style={{ bottom: 0, left: 0,   width: S, height: S, cursor: "sw-resize" }} />
    </>
  );
}
