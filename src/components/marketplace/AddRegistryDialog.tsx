import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { Button, Input, Modal, Select } from "neogestify-ui-components";
import { FolderIcon, AnimateSpin } from "neogestify-ui-components";
import { RegistrySourceType, RegistryProgress, useMarketplaceStore } from "../../store/marketplace";
import { RegistryProgressBar } from "./RegistryProgress";

interface AddRegistryDialogProps {
  onClose: () => void;
}

export function AddRegistryDialog({ onClose }: AddRegistryDialogProps) {
  const { t } = useTranslation();
  const addRegistry = useMarketplaceStore((s) => s.addRegistry);
  const [sourceType, setSourceType] = useState<RegistrySourceType>("github");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<RegistryProgress | null>(null);
  /** Cómo se interpretó lo que el usuario escribió; `null` mientras no sea válido. */
  const [resolved, setResolved] = useState<string | null>(null);

  // El id se genera acá y se le pasa al backend: los eventos de progreso vienen
  // etiquetados con él, y `addRegistry` recién resuelve cuando el repo terminó de
  // resolverse — o sea, demasiado tarde para saber a qué id escuchar.
  const registryId = useRef(crypto.randomUUID()).current;

  useEffect(() => {
    const unlisten = listen<RegistryProgress>("cc-registry-progress", (e) => {
      if (e.payload.registryId === registryId) setProgress(e.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [registryId]);

  // Preview en vivo de la ubicación: le muestra al usuario en qué se traduce el link que
  // pegó (o el error) antes de darle a "Agregar". Con debounce para no invocar en cada
  // tecla, y descartando respuestas viejas si el input siguió cambiando.
  useEffect(() => {
    const raw = location.trim();
    // En skills.sh la ubicación es un filtro opcional, así que vacío también es un estado
    // válido que vale la pena mostrar resuelto ("todo skills.sh").
    if (!raw && sourceType !== "skillssh") { setResolved(null); return; }
    let stale = false;
    const timer = setTimeout(() => {
      invoke<string>("preview_registry_location", { sourceType, location: raw })
        .then((r) => { if (!stale) setResolved(r); })
        .catch(() => { if (!stale) setResolved(null); });
    }, 250);
    return () => { stale = true; clearTimeout(timer); };
  }, [location, sourceType]);

  const handleBrowse = async () => {
    const selected = await open({ directory: true, multiple: false, title: t("marketplace.add.pickFolder") });
    if (typeof selected === "string" && selected) setLocation(selected);
  };

  const handleSubmit = async () => {
    if (!name.trim() || (!location.trim() && sourceType !== "skillssh")) {
      setError(t("marketplace.add.error.required"));
      return;
    }
    setBusy(true);
    setError("");
    setProgress(null);
    try {
      await addRegistry(name.trim(), sourceType, location.trim(), registryId);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("marketplace.add.title")}
      onClose={onClose}
      size="md"
      closeOnBackdrop={!busy}
      closeOnEsc={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={handleSubmit}
            leftIcon={busy ? <AnimateSpin className="w-4 h-4" /> : undefined}
          >
            {busy ? t("marketplace.add.adding") : t("btn.add")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Select
          label={t("marketplace.add.sourceType")}
          value={sourceType}
          onChange={(e) => { setSourceType(e.target.value as RegistrySourceType); setLocation(""); }}
          options={[
            { value: "github", label: t("marketplace.add.sourceGithub") },
            { value: "skillssh", label: t("marketplace.add.sourceSkillsSh") },
            { value: "local", label: t("marketplace.add.sourceLocal") },
          ]}
          variant="outline"
          disabled={busy}
        />

        <Input
          label={t("marketplace.add.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("marketplace.add.namePlaceholder")}
          variant="outline"
          disabled={busy}
        />

        {sourceType === "skillssh" ? (
          <div className="flex flex-col gap-1">
            <Input
              label={t("marketplace.add.skillsShOwner")}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t("marketplace.add.skillsShOwnerPlaceholder")}
              variant="outline"
              disabled={busy}
            />
            {resolved ? (
              <p className="text-xs font-mono text-blue-500 dark:text-blue-400 truncate">→ {resolved}</p>
            ) : (
              <p className="text-xs text-gray-400 dark:text-white/40">
                {t("marketplace.add.skillsShHelper")}
              </p>
            )}
          </div>
        ) : sourceType === "github" ? (
          <div className="flex flex-col gap-1">
            <Input
              label={t("marketplace.add.githubLocation")}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="https://github.com/owner/repo"
              variant="outline"
              disabled={busy}
            />
            {resolved && resolved !== location.trim() ? (
              // El link se entendió y se guardará en forma corta — mostrarlo evita la duda
              // de "¿habrá tomado bien la subcarpeta?" al pegar una URL de navegación.
              <p className="text-xs font-mono text-blue-500 dark:text-blue-400 truncate">
                → {resolved}
              </p>
            ) : (
              <p className="text-xs text-gray-400 dark:text-white/40">
                {t("marketplace.add.githubHelper")}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Button variant="outline" leftIcon={<FolderIcon />} fullWidth disabled={busy} onClick={handleBrowse}>
              {t("marketplace.add.pickFolder")}
            </Button>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t("marketplace.add.localPlaceholder")}
              variant="outline"
              disabled={busy}
            />
            {resolved && (
              <p className="text-xs font-mono text-blue-500 dark:text-blue-400 truncate">✓ {resolved}</p>
            )}
          </div>
        )}
      </div>

      {busy && <div className="mt-4"><RegistryProgressBar progress={progress} /></div>}

      {error && <p className="text-xs text-red-500 dark:text-red-400 mt-3">{error}</p>}
    </Modal>
  );
}
