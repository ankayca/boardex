// tools/mock-runner — placeholder entrypoint. The full fixture-replay server
// (Command API + WebSocket event stream, BIBLE §5.3/§5.6) is implemented in T0.4.
// For now this only proves the dev pipeline is wired.
console.log('mock runner listening');

// Keep the process alive so `npm run dev` shows the runner running beside the UI.
setInterval(() => undefined, 1 << 30);
