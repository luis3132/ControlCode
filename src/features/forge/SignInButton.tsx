import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { AddGitAccountDialog } from "./AddGitAccountDialog";
import type { RepoTarget } from "./types";

/** "Iniciar sesión en <host>" con el tipo y el host ya puestos. */
export function SignInButton({ target, label, variant = "primary" }: {
  target: Pick<RepoTarget, "host" | "kind">;
  label?: string;
  variant?: "primary" | "outline";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        {label ?? t("forge.signIn", { host: target.host })}
      </Button>
      {open && <AddGitAccountDialog kind={target.kind} host={target.host} onClose={() => setOpen(false)} />}
    </>
  );
}
