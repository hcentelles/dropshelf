// The channel carries change notices only. File data still comes from the API.
export function initLiveUpdates(changed: () => void): void {
  const url = new URL('/api/updates', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let attempts = 0;
  let lastMessage = 0;
  let stopped = false;

  function connect(): void {
    if (stopped || socket || !navigator.onLine) return;
    clearTimeout(retry);
    retry = undefined;
    const connection = new WebSocket(url);
    socket = connection;
    const opening = setTimeout(() => { connection.close(); }, 15_000);
    connection.addEventListener('open', () => {
      clearTimeout(opening);
      attempts = 0;
      lastMessage = Date.now();
      heartbeat = setInterval(() => {
        if (Date.now() - lastMessage > 65_000) connection.close();
        else if (connection.readyState === WebSocket.OPEN) connection.send('ping');
      }, 25_000);
    });
    connection.addEventListener('message', event => {
      lastMessage = Date.now();
      if (event.data === 'refresh') changed();
    });
    connection.addEventListener('error', () => { connection.close(); });
    connection.addEventListener('close', () => {
      clearTimeout(opening);
      clearInterval(heartbeat);
      if (socket === connection) socket = undefined;
      if (!stopped && navigator.onLine) {
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5));
        retry = setTimeout(connect, delay + Math.random() * 500);
      }
    });
  }

  function resume(): void {
    if (!navigator.onLine || stopped) return;
    changed();
    if (socket?.readyState === WebSocket.OPEN && Date.now() - lastMessage > 65_000) socket.close();
    else if (!socket) connect();
  }
  window.addEventListener('online', resume);
  window.addEventListener('offline', () => { socket?.close(); });
  window.addEventListener('focus', resume);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resume(); });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(retry); clearInterval(heartbeat); socket?.close(); });
  window.addEventListener('pageshow', () => { stopped = false; resume(); });
  connect();
}
