export function normalizeMargins(current = {}, patch = {}) {
  const merged = { ...current, ...patch };
  const clamp = (value, fallback, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(0, Number(value))) : fallback;
  const legacy = (100 - Math.max(40, clamp(merged.contentWidth, 76, 100))) / 2;
  const legacyPatch = "contentWidth" in patch && !("marginLeft" in patch) && !("marginRight" in patch);
  let left = legacyPatch ? legacy : clamp(merged.marginLeft, legacy, 60);
  let right = legacyPatch ? legacy : clamp(merged.marginRight, legacy, 60);
  if (left + right > 60) right = 60 - left;
  return { marginLeft: left, marginRight: right, marginsLinked: legacyPatch ? true : (typeof merged.marginsLinked === "boolean" ? merged.marginsLinked : left === right), contentWidth: 100 - left - right };
}
