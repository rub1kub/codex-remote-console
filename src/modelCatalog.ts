import type { AppPreferences, CodexModel, ReasoningLevel } from "./types";

export type ModelPickerOption = {
  value: string;
  label: string;
  shortLabel: string;
};

const standardEfforts = ["low", "medium", "high", "xhigh"];
const extendedEfforts = [...standardEfforts, "max", "ultra"];

function reasoningOptions(values: string[]) {
  return values.map((reasoningEffort) => ({ reasoningEffort, description: "" }));
}

export const fallbackCodexModels: CodexModel[] = [
  {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: reasoningOptions(extendedEfforts),
    serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }]
  },
  {
    id: "gpt-5.6-terra",
    model: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    description: "Balanced agentic coding model for everyday work.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: reasoningOptions(extendedEfforts),
    serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }]
  },
  {
    id: "gpt-5.6-luna",
    model: "gpt-5.6-luna",
    displayName: "GPT-5.6-Luna",
    description: "Fast and affordable agentic coding model.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: reasoningOptions([...standardEfforts, "max"]),
    serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }]
  },
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Frontier model for complex coding, research, and real-world work.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: reasoningOptions(standardEfforts),
    serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }]
  },
  {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "Strong model for everyday coding.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: reasoningOptions(standardEfforts),
    serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }]
  },
  {
    id: "gpt-5.4-mini",
    model: "gpt-5.4-mini",
    displayName: "GPT-5.4-Mini",
    description: "Small, fast, and cost-efficient model for simpler coding tasks.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: reasoningOptions(standardEfforts),
    serviceTiers: []
  },
  {
    id: "gpt-5.3-codex-spark",
    model: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3-Codex-Spark",
    description: "Ultra-fast coding model.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: reasoningOptions(standardEfforts),
    serviceTiers: []
  }
];

function shortModelLabel(displayName: string) {
  if (/codex-spark/i.test(displayName)) return "Spark";
  return displayName.replace(/^GPT-/i, "").replace(/-/g, " ");
}

export function modelPickerOptions(models: CodexModel[]): ModelPickerOption[] {
  const visible = models.filter((model) => !model.hidden);
  return [
    { value: "", label: "по умолчанию", shortLabel: "" },
    ...visible.map((model) => ({
      value: model.model,
      label: model.displayName,
      shortLabel: shortModelLabel(model.displayName)
    }))
  ];
}

export function modelForSelection(models: CodexModel[], selectedModel: string) {
  return selectedModel
    ? models.find((model) => model.model === selectedModel || model.id === selectedModel)
    : models.find((model) => model.isDefault);
}

export function reasoningEffortForPreference(level: ReasoningLevel) {
  return level === "very-high" ? "xhigh" : level;
}

export function preferenceForReasoningEffort(effort: string): ReasoningLevel | null {
  if (effort === "xhigh") return "very-high";
  if (["low", "medium", "high", "max", "ultra"].includes(effort)) {
    return effort as ReasoningLevel;
  }
  return null;
}

export function modelSupportsReasoning(model: CodexModel | undefined, level: ReasoningLevel) {
  if (!model) return true;
  const effort = reasoningEffortForPreference(level);
  return model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort);
}

export function serviceTierForSpeed(
  model: CodexModel | undefined,
  speed: AppPreferences["responseSpeed"]
) {
  if (speed !== "fast") return null;
  if (model?.serviceTiers?.length) {
    return model.serviceTiers[0].id;
  }
  return model?.additionalSpeedTiers?.includes("fast") ? "fast" : null;
}
