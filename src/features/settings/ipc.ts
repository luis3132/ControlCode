/** Instalación de la CLI `ccode` en el PATH del usuario. Ver `ipc/install.rs`. */
import { invoke } from "@tauri-apps/api/core";

export interface CliInstallStatus {
  installed: boolean;
  targetPath: string;
  sourcePath: string | null;
  dirInPath: boolean;
  targetDir: string;
  method: "symlink" | "copy";
}

export const cliInstallStatus = () => invoke<CliInstallStatus>("cli_install_status");

export const installCli = () => invoke<CliInstallStatus>("install_cli");

export const uninstallCli = () => invoke<CliInstallStatus>("uninstall_cli");
