import { useState } from "react";
import { Button, Input } from "neogestify-ui-components";
import { TrashIcon, AddIcon, ThemeToggle } from "neogestify-ui-components";
import { useSettingsStore } from "../store/settings";

export function SettingsPage() {
  const { customAgents, addCustomAgent, removeCustomAgent } = useSettingsStore();
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");

  const handleAdd = () => {
    if (!label.trim() || !command.trim()) {
      setError("El nombre y el comando son obligatorios");
      return;
    }
    addCustomAgent({ label: label.trim(), command: command.trim() });
    setLabel("");
    setCommand("");
    setError("");
  };

  return (
    <div className="flex flex-col min-h-full p-8 max-w-2xl mx-auto gap-8
      bg-gray-50 dark:bg-[#0d1117]">

      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Configuración</h2>
        <p className="text-sm text-gray-500 dark:text-white/40 mt-1">
          Personaliza tu entorno de Control Code
        </p>
      </div>

      {/* Tema */}
      <section className="flex flex-col gap-4 p-5 rounded-2xl border
        bg-white dark:bg-[#161b22]
        border-gray-200 dark:border-white/10">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-white/70 uppercase tracking-wider">
            Apariencia
          </h3>
          <p className="text-xs text-gray-400 dark:text-white/40 mt-1">
            Cambia entre tema claro y oscuro
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600 dark:text-white/60">Tema:</span>
          <ThemeToggle />
        </div>
      </section>

      {/* TUIs personalizadas */}
      <section className="flex flex-col gap-4 p-5 rounded-2xl border
        bg-white dark:bg-[#161b22]
        border-gray-200 dark:border-white/10">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-white/70 uppercase tracking-wider">
            TUIs personalizadas
          </h3>
          <p className="text-xs text-gray-400 dark:text-white/40 mt-1">
            Agrega herramientas no detectadas automáticamente (ej: aider, continue, opencode)
          </p>
        </div>

        {customAgents.length === 0 ? (
          <p className="text-xs italic text-gray-400 dark:text-white/30 py-1">
            No hay TUIs personalizadas todavía
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {customAgents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border
                  bg-gray-50 dark:bg-white/5
                  border-gray-200 dark:border-white/10"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-gray-800 dark:text-white/90">
                    {agent.label}
                  </span>
                  <span className="text-xs font-mono text-gray-400 dark:text-white/40">
                    {agent.command}
                  </span>
                </div>
                <Button variant="danger" onClick={() => removeCustomAgent(agent.id)}>
                  <TrashIcon />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Formulario */}
        <div className="flex flex-col gap-3 p-4 rounded-xl border border-dashed
          border-gray-300 dark:border-white/20
          bg-gray-50 dark:bg-white/[0.02]">
          <p className="text-xs font-medium text-gray-500 dark:text-white/50">
            Agregar nueva TUI
          </p>
          <div className="flex gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              placeholder="Nombre (ej: Aider)"
              variant="outline"
            />
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              placeholder="Comando (ej: aider)"
              variant="outline"
            />
          </div>
          {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
          <Button variant="primary" leftIcon={<AddIcon />} onClick={handleAdd}>
            Agregar
          </Button>
        </div>
      </section>
    </div>
  );
}
