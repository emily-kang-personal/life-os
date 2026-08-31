/**
 * The only logging primitive. The event union makes tool arguments, results,
 * bodies, headers, URLs, Error objects, and credential values unrepresentable:
 * every field is a plain string/number drawn from the allowed metadata set
 * (timestamp, level, event, request ID, source ID, tool name, outcome,
 * duration).
 */
const ERROR_EVENTS = new Set([
    "startup_failed",
    "fatal",
]);
/**
 * Creates the single JSONL writer. Each event serializes once to one compact
 * line and is written once to the stream. A serialization or write failure
 * invokes onWriteFailure exactly once; the logger never throws.
 */
export function createLogger(stream, onWriteFailure) {
    let failed = false;
    return function logEvent(event) {
        if (failed) {
            return;
        }
        try {
            const line = JSON.stringify({
                ts: new Date().toISOString(),
                level: ERROR_EVENTS.has(event.event) ? "error" : "info",
                ...event,
            });
            stream.write(line + "\n", (writeError) => {
                if (writeError !== null && writeError !== undefined && !failed) {
                    failed = true;
                    onWriteFailure();
                }
            });
        }
        catch {
            failed = true;
            onWriteFailure();
        }
    };
}
