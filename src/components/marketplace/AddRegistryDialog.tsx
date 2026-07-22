import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { Button, Input, Modal, Select } from "neogestify-ui-components";
import { FolderIcon } from "neogestify-ui-components";
import { RegistrySourceType, useMarketplaceStore } from "../../store/marketplace";

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

  const handleBrowse = async () => {
    const selected = await open({ directory: true, multiple: false, title: t("marketplace.add.pickFolder") });
    if (typeof selected === "string" && selected) setLocation(selected);
  };

  const handleSubmit = async () => {
    if (!name.trim() || !location.trim()) {
      setError(t("marketplace.add.error.required"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await addRegistry(name.trim(), sourceType, location.trim());
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
          <Button variant="primary" disabled={busy} onClick={handleSubmit}>
            {t("btn.add")}
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
            { value: "local", label: t("marketplace.add.sourceLocal") },
          ]}
          variant="outline"
        />

        <Input
          label={t("marketplace.add.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("marketplace.add.namePlaceholder")}
          variant="outline"
        />

        {sourceType === "github" ? (
          <div className="flex flex-col gap-1">
            <Input
              label={t("marketplace.add.githubLocation")}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="owner/repo"
              variant="outline"
            />
            <p className="text-xs text-gray-400 dark:text-white/40">
              {t("marketplace.add.githubHelper")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Button variant="outline" leftIcon={<FolderIcon />} fullWidth onClick={handleBrowse}>
              {t("marketplace.add.pickFolder")}
            </Button>
            {location && (
              <p className="text-xs font-mono text-blue-500 dark:text-blue-400 truncate">✓ {location}</p>
            )}
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-500 dark:text-red-400 mt-3">{error}</p>}
    </Modal>
  );
}
