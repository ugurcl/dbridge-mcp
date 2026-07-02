export type AuditEvent = Record<string, unknown>;
export type AuditFn = (event: AuditEvent) => void;

export function createAudit(enabled: boolean): AuditFn {
  if (!enabled) {
    return () => undefined;
  }
  return (event) => {
    try {
      process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
    } catch {
      return;
    }
  };
}
