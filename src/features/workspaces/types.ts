export interface WorkspaceSummary {
  id: string;
  name: string;
  lastActive: number;
  windowCount: number;
  tabCount: number;
  /** Ventanas marcadas abiertas: si hay alguna, abrirlo es ir a ella. */
  openWindowCount: number;
  /** Las carpetas de sus tabs, sin repetir. */
  folders: string[];
}
