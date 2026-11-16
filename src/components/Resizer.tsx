import { useRef } from "react";
import { get, set } from "../store";
import { clamp } from "../util";

export function Resizer({ kind }: { kind: "sidebar" | "panel" }) {
  const start = useRef<{ pos: number; size: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const state = get();
    start.current = { pos: kind === "sidebar" ? event.clientX : event.clientY, size: kind === "sidebar" ? state.sidebarWidth : state.panelHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add(kind === "sidebar" ? "resizing-x" : "resizing-y");
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    if (kind === "sidebar") {
      set({ sidebarWidth: clamp(start.current.size + event.clientX - start.current.pos, 200, 620) });
    } else {
      const max = window.innerHeight - 160;
      set({ panelHeight: clamp(start.current.size - (event.clientY - start.current.pos), 120, max) });
    }
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    start.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove("resizing-x", "resizing-y");
  };
  return (
    <div
      className={`resizer resizer-${kind}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => (kind === "sidebar" ? set({ sidebarWidth: 286 }) : set({ panelHeight: 300 }))}
    />
  );
}
