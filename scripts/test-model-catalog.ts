import assert from "node:assert/strict";

import {
  fallbackCodexModels,
  modelForSelection,
  modelPickerOptions,
  modelSupportsReasoning,
  preferenceForReasoningEffort,
  serviceTierForSpeed
} from "../src/modelCatalog";

const options = modelPickerOptions(fallbackCodexModels);
assert.equal(options[0].value, "");
assert(options.some((option) => option.value === "gpt-5.6-sol"));
assert(options.some((option) => option.value === "gpt-5.6-terra"));
assert(options.some((option) => option.value === "gpt-5.6-luna"));

const sol = modelForSelection(fallbackCodexModels, "");
const luna = modelForSelection(fallbackCodexModels, "gpt-5.6-luna");
const mini = modelForSelection(fallbackCodexModels, "gpt-5.4-mini");
assert.equal(sol?.model, "gpt-5.6-sol");
assert.equal(modelSupportsReasoning(sol, "ultra"), true);
assert.equal(modelSupportsReasoning(luna, "ultra"), false);
assert.equal(modelSupportsReasoning(luna, "max"), true);
assert.equal(preferenceForReasoningEffort("xhigh"), "very-high");
assert.equal(serviceTierForSpeed(sol, "fast"), "priority");
assert.equal(serviceTierForSpeed(mini, "fast"), null);

console.log("model catalog: ok");
