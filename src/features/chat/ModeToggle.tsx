import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Tooltip } from "neogestify-ui-components";

import type { Tab } from "@/features/tabs/types";

import { useChatStore } from "./store";
import { switchToHtml, switchToTerminal } from "./switchMode";

/**
 * El botón de la esquina de arriba a la derecha de una tab de Claude Code: pasa de la TUI
 * al chat de la app y de vuelta, con la misma conversación.
 *
 * Volver a la consola con un turno andando lo corta (dos procesos sobre la misma sesión se
 * pisarían): por eso en ese caso pide un segundo click.
 */
export function ModeToggle({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const html = tab.mode === "html";
  const busy = useChatStore((s) => {
    const c = s.chats[tab.id];
    return !!c && (c.running || c.starting);
  });
  const [switching, setSwitching] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const toggle = async () => {
    if (html && busy && !confirm) {
      setConfirm(true);
      window.setTimeout(() => setConfirm(false), 4000);
      return;
    }
    setSwitching(true);
    setConfirm(false);
    try {
      await (html ? switchToTerminal(tab) : switchToHtml(tab));
    } finally {
      setSwitching(false);
    }
  };

  const label = confirm ? t("chat.toggle.confirm") : html ? t("chat.toggle.toTerminal") : t("chat.toggle.toHtml");
  return (
    <div className="absolute top-2 right-4 z-20">
      <Tooltip content={html ? t("chat.toggle.toTerminalHint") : t("chat.toggle.toHtmlHint")} placement="bottom-end">
        <Button
          variant="custom"
          onClick={() => void toggle()}
          disabled={switching}
          aria-label={label}
          className={`cc-t h-6 px-2 rounded-md text-[11px] font-medium border shadow-sm backdrop-blur
            disabled:opacity-50
            ${confirm
              ? "bg-amber-500 text-white border-amber-500"
              : "bg-white/85 text-gray-700 border-gray-200 hover:bg-white dark:bg-[#161b22]/85 dark:text-gray-200 dark:border-white/10 dark:hover:bg-[#161b22]"}
            ${html ? "" : "opacity-60 hover:opacity-100"}`}
        >
          {label}
        </Button>
      </Tooltip>
    </div>
  );
}
