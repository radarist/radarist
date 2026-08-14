/**
 * Process-local serialization for start/stop operations on one retained build
 * runtime. The app is intentionally single-process/local; this prevents two
 * UI requests from racing destructive Docker recreation/state transitions.
 */
const operationsInFlight = new Set<string>();

export function acquireBuildRuntimeOperation(missionId: string): (() => void) | null {
  if (operationsInFlight.has(missionId)) return null;
  operationsInFlight.add(missionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    operationsInFlight.delete(missionId);
  };
}
