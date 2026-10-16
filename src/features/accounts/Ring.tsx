/** Un anillo de progreso: el arco es `percent` (0–100) del círculo. `null` = no se sabe. */
export function Ring({ percent, color, size = 22, stroke = 2.6 }: {
  percent: number | null;
  color: string;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${(c * value) / 100} ${c}`} opacity={percent === null ? 0.25 : 1}
        style={{ transition: "stroke-dasharray 600ms ease" }} />
    </svg>
  );
}

/** El color de cada agente en los anillos y las barras. */
export function agentColor(agentId: string): string {
  if (agentId === "claude-code") return "#f08a5d";
  if (agentId === "codex") return "#34c79b";
  if (agentId === "gemini" || agentId === "antigravity") return "#6aa5f5";
  return "#94a3b8";
}

/** Con el uso alto, el color deja de ser el del agente: un 90 % se ve distinto de un 10 %. */
export function usageColor(percent: number, agentId: string): string {
  if (percent >= 90) return "#ef4444";
  if (percent >= 70) return "#f59e0b";
  return agentColor(agentId);
}

/**
 * Dos anillos en uno: afuera la ventana corta (la sesión de 5 h) y adentro, más fino, la de
 * la semana. Entran en el mismo lugar que uno solo, así un vistazo dice si lo que se agota es
 * la sesión o la semana. Sin `inner` es un anillo común.
 */
export function DualRing({ outer, inner, agentId, size = 14 }: {
  outer: number | null;
  inner: number | null;
  agentId: string;
  size?: number;
}) {
  const c = size / 2;
  const arc = (percent: number | null, r: number, stroke: number, key: string) => {
    const len = 2 * Math.PI * r;
    const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
    const color = percent === null ? agentColor(agentId) : usageColor(percent, agentId);
    return (
      <g key={key}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={stroke} />
        <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${(len * value) / 100} ${len}`} opacity={percent === null ? 0.25 : 1}
          style={{ transition: "stroke-dasharray 600ms ease" }} />
      </g>
    );
  };
  const outerStroke = 1.8;
  const innerStroke = 1.5;
  const rOuter = (size - outerStroke) / 2;
  const rInner = rOuter - outerStroke / 2 - 1 - innerStroke / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0 -rotate-90">
      {arc(outer, rOuter, outerStroke, "outer")}
      {inner !== null && rInner > 1 && arc(inner, rInner, innerStroke, "inner")}
    </svg>
  );
}
