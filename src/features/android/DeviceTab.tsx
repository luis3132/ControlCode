import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { NavBackIcon, NavHomeIcon, NavRecentsIcon, PhoneIcon, PowerIcon, RefreshIcon, VolumeIcon } from "@/app/icons";
import { agentPaint } from "@/features/browser/agentPaint";
import { ToolButton, ToolbarSeparator } from "@/features/browser/toolbarButtons";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import type { AndroidView } from "@/features/tabs/viewTabs";

import { fitInside, gesture, toDevice, wheelSwipe, type Size } from "./geometry";
import { androidInput, androidSelect, androidStartAvd, deviceName, type UserInput } from "./ipc";
import { specialKey, typedChar, untypeable } from "./keys";
import { TOUCH_MS, useAndroidStore, type ShownTouch } from "./store";
import { useScreen } from "./stream";

/** Cada cuánto se vuelve a mirar qué dispositivos hay, mientras la vista se ve. */
const DEVICES_EVERY_MS = 3000;
/** Cuánto se juntan las letras antes de mandarlas: una llamada a adb por letra se notaría. */
const TYPE_BATCH_MS = 140;

/**
 * La pantalla de un dispositivo Android, en vivo, que se usa con el mouse como dedo y con
 * el teclado de la computadora. Es la misma pantalla que usan los agentes con las tools
 * `android_*`: cada toque suyo se dibuja con su color, así se ve quién está haciendo qué.
 */
export function DeviceTab({ view, shown }: { view: AndroidView; shown: boolean }) {
  const { t } = useTranslation();
  const status = useAndroidStore((s) => s.status);
  const refresh = useAndroidStore((s) => s.refresh);
  const touches = useAndroidStore((s) => s.touches);

  const devices = status?.devices ?? [];
  const ready = devices.filter((d) => d.state === "device");
  const device = ready.find((d) => d.serial === view.serial) ?? (view.serial ? undefined : ready[0]);
  const chosen = devices.find((d) => d.serial === view.serial);
  const serial = device?.serial ?? null;

  const screen = useScreen(serial, shown);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const explain = (message: string) => (message.startsWith("INJECT_EVENTS") ? t("android.injectBlocked") : message);

  // Lo que el teléfono no dejó hacer (los toques van sin esperar respuesta).
  useEffect(() => {
    if (!serial) return;
    const off = listen<{ serial: string; message: string }>("android-input-error", (e) => {
      if (e.payload.serial === serial) setNotice(explain(e.payload.message));
    });
    return () => void off.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial]);

  // Mientras se ve, mirar seguido qué hay conectado: enchufar el teléfono tiene que alcanzar.
  useEffect(() => {
    if (!shown) return;
    refresh();
    const timer = setInterval(() => refresh(), DEVICES_EVERY_MS);
    return () => clearInterval(timer);
  }, [shown, refresh]);

  // El nombre de la tab es el del dispositivo, y los agentes usan el que se ve acá.
  useEffect(() => {
    if (!device) return;
    const title = deviceName(device);
    if (view.title !== title) useViewTabsStore.getState().updateView(view.id, { title });
    if (shown) androidSelect(device.serial).catch(() => {});
  }, [device, shown, view.id, view.title]);

  // Lo que hace un agente se ve enseguida, sin esperar al próximo cuadro.
  const latestAgent = useMemo(
    () => [...touches].reverse().find((x) => x.ownerId && x.touch.serial === serial) ?? null,
    [touches, serial]
  );
  useEffect(() => {
    if (latestAgent) setTimeout(() => screen.kick(), 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestAgent]);

  /** Manda algo al dispositivo, en orden, y pide el cuadro que lo muestra. */
  const send = (action: UserInput) => {
    if (!serial) return;
    queue.current = queue.current
      .then(() => androidInput(serial, action))
      .then(() => {
        if (action.kind !== "down" && action.kind !== "move") screen.kick();
      })
      .catch((e) => setNotice(explain(String(e))));
  };

  const pressKey = (key: string) => {
    send({ kind: "key", key });
    if (serial) useAndroidStore.getState().addTouch({ serial, kind: "key", x: null, y: null, x2: null, y2: null, label: key }, null, "");
  };

  if (!status) return <Shell>{null}</Shell>;

  if (!status.adb) {
    return (
      <Shell>
        <Empty title={t("android.noAdb.title")} body={t("android.noAdb.body")} />
      </Shell>
    );
  }

  const toolbar = (
    <div className="flex items-center gap-1 h-11 shrink-0 px-2 border-b border-gray-200 dark:border-white/7">
      <select
        value={serial ?? view.serial ?? ""}
        onChange={(e) => useViewTabsStore.getState().updateView(view.id, { serial: e.target.value || null })}
        aria-label={t("android.device")}
        className="h-8 max-w-56 min-w-0 px-2 rounded-lg text-[12px] bg-transparent border border-gray-300 dark:border-white/15
          text-gray-800 dark:text-gray-100 outline-none"
      >
        {devices.length === 0 && <option value="">{t("android.none")}</option>}
        {devices.map((d) => (
          <option key={d.serial} value={d.serial}>
            {deviceName(d)}{d.state === "device" ? "" : ` (${d.state})`}
          </option>
        ))}
      </select>
      <ToolbarSeparator />
      <ToolButton label={t("android.back")} disabled={!serial} onClick={() => pressKey("back")}>
        <NavBackIcon className="w-4 h-4 stroke-2" />
      </ToolButton>
      <ToolButton label={t("android.home")} disabled={!serial} onClick={() => pressKey("home")}>
        <NavHomeIcon className="w-4 h-4 stroke-2" />
      </ToolButton>
      <ToolButton label={t("android.recents")} disabled={!serial} onClick={() => pressKey("recents")}>
        <NavRecentsIcon className="w-4 h-4 stroke-2" />
      </ToolButton>
      <ToolbarSeparator />
      <ToolButton label={t("android.volumeDown")} disabled={!serial} onClick={() => pressKey("volume_down")}>
        <VolumeIcon className="w-4 h-4 stroke-2" />
      </ToolButton>
      <ToolButton label={t("android.volumeUp")} disabled={!serial} onClick={() => pressKey("volume_up")}>
        <VolumeIcon up className="w-4 h-4 stroke-2" />
      </ToolButton>
      <ToolButton label={t("android.power")} disabled={!serial} onClick={() => pressKey("power")}>
        <PowerIcon className="w-4 h-4 stroke-2" />
      </ToolButton>
      <div className="flex-1" />
      <ToolButton label={t("android.refresh")} onClick={() => { refresh(); screen.kick(); }}>
        <RefreshIcon className="w-4 h-4 stroke-2" />
      </ToolButton>
    </div>
  );

  let body: React.ReactNode;
  if (!device) {
    const hint = chosen && chosen.state !== "device"
      ? t(chosen.state === "unauthorized" ? "android.unauthorized" : "android.offline", { device: deviceName(chosen) })
      : null;
    body = (
      <Empty title={hint ?? t("android.empty.title")} body={hint ? null : t("android.empty.body")}>
        {status.avds.length > 0 && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs text-gray-500 dark:text-white/40">{t("android.avds")}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {status.avds.map((avd) => (
                <Button
                  key={avd}
                  variant="custom"
                  disabled={starting !== null}
                  onClick={() => {
                    setStarting(avd);
                    androidStartAvd(avd)
                      .catch((e) => setNotice(String(e)))
                      // El emulador tarda en aparecer en `adb devices`; la vista lo encuentra sola.
                      .finally(() => setTimeout(() => setStarting(null), 20_000));
                  }}
                  className="cc-t h-8 px-3 rounded-lg border border-gray-300 dark:border-white/15 text-[12px] font-semibold
                    text-gray-800 dark:text-gray-100 hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-50"
                >
                  {starting === avd ? t("android.starting") : avd.replace(/_/g, " ")}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Empty>
    );
  } else {
    body = (
      <Screen
        serial={device.serial}
        canvas={screen.canvas}
        frame={screen.size}
        error={screen.error}
        touches={touches.filter((x) => x.touch.serial === device.serial)}
        acting={latestAgent}
        onInput={send}
        onKey={pressKey}
        onNotice={setNotice}
      />
    );
  }

  return (
    <Shell>
      {toolbar}
      {notice && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[12px] bg-amber-500/12 text-amber-800 dark:text-amber-200">
          <span className="flex-1 min-w-0">{notice}</span>
          <button className="cc-t text-[11px] font-semibold hover:underline" onClick={() => setNotice(null)}>{t("btn.close")}</button>
        </div>
      )}
      {body}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col h-full min-h-0 bg-gray-50 dark:bg-surface">{children}</div>;
}

function Empty({ title, body, children }: { title: string; body?: string | null; children?: React.ReactNode }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
      <PhoneIcon className="w-8 h-8 text-gray-400 dark:text-white/25" />
      <div className="flex flex-col gap-1 max-w-sm">
        <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</p>
        {body && <p className="text-xs leading-relaxed text-gray-500 dark:text-white/45">{body}</p>}
      </div>
      {children}
    </div>
  );
}

/** La pantalla y lo que se hace sobre ella. */
function Screen({ serial, canvas, frame, error, touches, acting, onInput, onKey, onNotice }: {
  serial: string;
  canvas: HTMLCanvasElement;
  /** El tamaño de la pantalla del dispositivo. */
  frame: Size | null;
  error: string | null;
  touches: ShownTouch[];
  acting: ShownTouch | null;
  onInput: (action: UserInput) => void;
  onKey: (key: string) => void;
  onNotice: (text: string) => void;
}) {
  const { t } = useTranslation();
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const press = useRef<{
    device: { x: number; y: number };
    client: { x: number; y: number };
    at: number;
    /** Por dónde va el dedo, y el próximo MOVE que espera al siguiente cuadro de animación. */
    last: { x: number; y: number };
    pending: { x: number; y: number } | null;
    raf: number;
  } | null>(null);
  const typed = useRef("");
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheel = useRef<{ delta: number; at: { x: number; y: number }; timer: ReturnType<typeof setTimeout> | null }>({
    delta: 0, at: { x: 0, y: 0 }, timer: null,
  });

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shown = frame ? fitInside(box, frame) : { width: 0, height: 0 };

  const devicePoint = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    if (!frame) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    return toDevice({ x: e.clientX - rect.left, y: e.clientY - rect.top }, shown, frame);
  };

  /** Como `devicePoint`, pero pegado al borde si el mouse se salió de la pantalla. */
  const clampedPoint = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    if (!frame) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), shown.width - 1);
    const y = Math.min(Math.max(e.clientY - rect.top, 0), shown.height - 1);
    return toDevice({ x, y }, shown, frame);
  };

  /** Levanta el dedo: al soltar, o si el navegador cancela el gesto. */
  const release = (end: { x: number; y: number } | null, clientEnd: { x: number; y: number } | null) => {
    const start = press.current;
    press.current = null;
    if (!start) return;
    if (start.raf) cancelAnimationFrame(start.raf);
    const at = end ?? start.last;
    onInput({ kind: "up", ...at });
    const moved = clientEnd ? Math.hypot(clientEnd.x - start.client.x, clientEnd.y - start.client.y) : 0;
    showOwn(gesture(start.device, at, moved, performance.now() - start.at));
  };

  // El canvas lo maneja `useScreen`; acá solo se cuelga.
  const mountCanvas = (el: HTMLDivElement | null) => {
    if (el && canvas.parentElement !== el) el.appendChild(canvas);
  };

  const showOwn = (action: UserInput) => {
    if (action.kind !== "tap" && action.kind !== "hold" && action.kind !== "swipe") return;
    useAndroidStore.getState().addTouch(
      {
        serial,
        kind: action.kind,
        x: action.x,
        y: action.y,
        x2: action.kind === "swipe" ? action.x2 : null,
        y2: action.kind === "swipe" ? action.y2 : null,
        label: null,
      },
      null,
      ""
    );
  };

  const flushTyped = () => {
    if (typeTimer.current) clearTimeout(typeTimer.current);
    typeTimer.current = null;
    const text = typed.current;
    typed.current = "";
    if (text) onInput({ kind: "text", text });
  };

  const typeText = (text: string) => {
    const bad = untypeable(text);
    if (bad.length > 0) onNotice(t("android.untypeable", { chars: bad.join(" ") }));
    const ok = [...text].filter((c) => !bad.includes(c)).join("");
    if (!ok) return;
    typed.current += ok;
    if (typeTimer.current) clearTimeout(typeTimer.current);
    typeTimer.current = setTimeout(flushTyped, TYPE_BATCH_MS);
  };

  const ownerColor = (touch: ShownTouch) => (touch.ownerId ? agentPaint(touch.ownerId).hex : "#94a3b8");
  const radius = frame ? Math.max(frame.width, frame.height) * 0.022 : 20;
  const actingNow = acting && Date.now() - acting.at < TOUCH_MS * 2 ? acting : null;
  const keyChip = [...touches].reverse().find((x) => x.touch.kind === "key" || x.touch.kind === "text");

  return (
    <div ref={stage} className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden p-3">
      {!frame && !error && <p className="text-xs text-gray-500 dark:text-white/40">{t("android.connecting")}</p>}
      {error && !frame && <p className="max-w-sm text-center text-xs text-red-600 dark:text-red-400">{error}</p>}
      {frame && shown.width > 0 && (
        <div
          tabIndex={0}
          role="application"
          aria-label={t("android.screen")}
          className="relative outline-none rounded-[14px] overflow-hidden shadow-lg ring-1 ring-black/10 dark:ring-white/10
            focus-visible:ring-2 focus-visible:ring-accent-500 select-none touch-none cursor-pointer"
          style={{
            width: shown.width,
            height: shown.height,
            boxShadow: actingNow ? `0 0 0 3px ${ownerColor(actingNow)}` : undefined,
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const point = devicePoint(e);
            if (!point) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.focus({ preventScroll: true });
            flushTyped();
            press.current = {
              device: point,
              client: { x: e.clientX, y: e.clientY },
              at: performance.now(),
              last: point,
              pending: null,
              raf: 0,
            };
            onInput({ kind: "down", ...point });
          }}
          onPointerMove={(e) => {
            const p = press.current;
            const point = p && clampedPoint(e);
            if (!p || !point) return;
            p.pending = point;
            // Un MOVE por cuadro de animación alcanza; el backend junta los que se atrasan.
            if (!p.raf) {
              p.raf = requestAnimationFrame(() => {
                p.raf = 0;
                const next = p.pending;
                p.pending = null;
                if (!next || press.current !== p || (next.x === p.last.x && next.y === p.last.y)) return;
                p.last = next;
                onInput({ kind: "move", ...next });
              });
            }
          }}
          onPointerUp={(e) => release(clampedPoint(e), { x: e.clientX, y: e.clientY })}
          onPointerCancel={() => release(null, null)}
          onLostPointerCapture={() => release(null, null)}
          // Click derecho es "atrás", como en scrcpy.
          onContextMenu={(e) => { e.preventDefault(); onKey("back"); }}
          onWheel={(e) => {
            const point = devicePoint(e);
            if (!point || !frame) return;
            const w = wheel.current;
            w.delta += e.deltaY;
            w.at = point;
            if (w.timer) clearTimeout(w.timer);
            w.timer = setTimeout(() => {
              const action = wheelSwipe(w.at, w.delta, frame);
              w.delta = 0;
              if (action) onInput(action);
            }, 90);
          }}
          onKeyDown={(e) => {
            const special = specialKey(e.key);
            if (special) {
              e.preventDefault();
              flushTyped();
              onKey(special);
              return;
            }
            const char = typedChar(e);
            if (char) {
              e.preventDefault();
              typeText(char);
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            typeText(e.clipboardData.getData("text/plain"));
          }}
        >
          <div ref={mountCanvas} className="absolute inset-0 pointer-events-none" />
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            viewBox={`0 0 ${frame.width} ${frame.height}`}
            preserveAspectRatio="none"
          >
            {touches.map((touch) => <TouchMark key={touch.id} touch={touch} color={ownerColor(touch)} radius={radius} />)}
          </svg>
          {keyChip && (
            <div
              className="absolute left-1/2 bottom-4 -translate-x-1/2 px-2.5 py-1 rounded-full text-[11px] font-semibold text-white shadow"
              style={{ background: ownerColor(keyChip) }}
            >
              {keyChip.touch.kind === "key" ? `⌨ ${keyChip.touch.label ?? ""}` : `“${keyChip.touch.label ?? ""}”`}
            </div>
          )}
        </div>
      )}
      {actingNow && (
        <div
          className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2.5 py-1 rounded-full
            text-[11px] font-semibold text-white shadow pointer-events-none"
          style={{ background: ownerColor(actingNow) }}
        >
          {t("android.agentActing", { agent: actingNow.ownerLabel || t("android.anAgent") })}
        </div>
      )}
    </div>
  );
}

/** Un toque, un toque largo o un deslizamiento, dibujado y desvaneciéndose. */
function TouchMark({ touch, color, radius }: { touch: ShownTouch; color: string; radius: number }) {
  const { kind, x, y, x2, y2 } = touch.touch;
  if (x === null || y === null) return null;
  const fade = <animate attributeName="opacity" from="0.95" to="0" dur={`${TOUCH_MS}ms`} fill="freeze" />;
  if (kind === "swipe" && x2 !== null && y2 !== null) {
    return (
      <g>
        <line x1={x} y1={y} x2={x2} y2={y2} stroke={color} strokeWidth={radius * 0.45} strokeLinecap="round" opacity="0.95">
          {fade}
        </line>
        <circle cx={x2} cy={y2} r={radius * 0.7} fill={color} opacity="0.95">{fade}</circle>
      </g>
    );
  }
  return (
    <g>
      <circle cx={x} cy={y} r={radius * 0.55} fill={color} opacity="0.95">{fade}</circle>
      <circle cx={x} cy={y} r={radius} fill="none" stroke={color} strokeWidth={radius * 0.18} opacity="0.95">
        <animate attributeName="r" from={radius * 0.6} to={radius * (kind === "hold" ? 2.6 : 1.8)} dur="600ms" fill="freeze" />
        {fade}
      </circle>
    </g>
  );
}
