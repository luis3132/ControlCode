import { useTranslation } from "react-i18next";
import { AgentInfo } from "../../store/tabs";

interface AgentPickerStepProps {
  agents: AgentInfo[];
  selected: string | null;
  onSelect: (agent: AgentInfo) => void;
}

const AGENT_COLORS: Record<string, string> = {
  "claude-code": "border-orange-500/40 hover:border-orange-500/80",
  "gemini-cli":  "border-blue-500/40 hover:border-blue-500/80",
  "codex":       "border-green-500/40 hover:border-green-500/80",
  "bash":        "border-white/20 hover:border-white/50",
};

const AGENT_SELECTED: Record<string, string> = {
  "claude-code": "border-orange-500 bg-orange-500/10",
  "gemini-cli":  "border-blue-500 bg-blue-500/10",
  "codex":       "border-green-500 bg-green-500/10",
  "bash":        "border-white/60 bg-white/5",
};

export function AgentPickerStep({ agents, selected, onSelect }: AgentPickerStepProps) {
  const { t } = useTranslation();
  const available = agents.filter((a) => a.available);

  if (available.length === 0) {
    return (
      <p className="text-xs text-white/30 italic">
        {t("wizard.step2.detecting")}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {available.map((agent) => {
        const isSelected = agent.id === selected;
        return (
          <button
            key={agent.id}
            onClick={() => onSelect(agent)}
            className={`
              flex flex-col gap-1 p-3 rounded-lg border text-left transition-all
              ${isSelected
                ? (AGENT_SELECTED[agent.id] ?? "border-violet-500 bg-violet-500/10")
                : (AGENT_COLORS[agent.id] ?? "border-white/20 hover:border-white/50")}
            `}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-white/90">{agent.label}</span>
              {agent.isCustom && (
                <span className="text-xs text-violet-400/70 bg-violet-500/10 px-1 rounded">
                  {t("wizard.step2.customBadge")}
                </span>
              )}
            </div>
            <span className="text-xs font-mono text-white/40">{agent.command}</span>
            {agent.version && (
              <span className="text-xs text-emerald-400/70">{agent.version}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
