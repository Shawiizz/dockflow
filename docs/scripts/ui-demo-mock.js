/**
 * Injected into the ui-demo build's index.html, before the Angular bundle loads.
 * Fakes the SSH/exec terminal WebSocket entirely client-side (no server involved)
 * so the demo can show a working terminal without a real backend or SSH connection.
 * Every other API call goes to real Next.js route handlers under /api/* — this
 * script only needs to cover the one thing that isn't a plain HTTP request.
 */
(function () {
  var RealWebSocket = window.WebSocket;

  var DEL = String.fromCharCode(127);
  var CTRL_C = String.fromCharCode(3);

  var RESPONSES = {
    'ls': 'Dockerfile  docker-compose.yml  .dockflow  README.md',
    'pwd': '/home/deploy/my-app',
    'whoami': 'dockflow',
    'docker ps': 'CONTAINER ID   IMAGE                    STATUS         NAMES\r\n8f3a2c1e9b4d   my-app:1.4.0             Up 2 hours     my-app-production_app.1',
    'help': "This is a simulated terminal for the Dockflow demo (no real server attached).\r\nTry: ls, pwd, whoami, docker ps",
  };

  function respond(cmd) {
    var trimmed = cmd.trim();
    if (!trimmed) return '';
    if (Object.prototype.hasOwnProperty.call(RESPONSES, trimmed)) return RESPONSES[trimmed];
    return trimmed + ': command not found (demo terminal — try "help")';
  }

  function isDemoUrl(url) {
    return /\/ws\/(ssh|exec)\//.test(String(url));
  }

  function MockWebSocket(url) {
    this.url = String(url);
    this.readyState = MockWebSocket.CONNECTING;
    this.binaryType = 'blob';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    this._buffer = '';
    var self = this;

    setTimeout(function () {
      self.readyState = MockWebSocket.OPEN;
      if (self.onopen) self.onopen({ target: self });
      setTimeout(function () {
        self._emit(JSON.stringify({ type: 'connected' }));
        self._emit("Simulated shell — this demo isn't connected to a real server.\r\n$ ");
      }, 250);
    }, 300);
  }

  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;

  MockWebSocket.prototype._emit = function (data) {
    if (this.onmessage) this.onmessage({ data: data, target: this });
  };

  MockWebSocket.prototype.send = function (data) {
    if (this.readyState !== MockWebSocket.OPEN) return;

    // Resize events are sent as JSON — ignore them, nothing to resize here.
    try {
      var parsed = JSON.parse(data);
      if (parsed && parsed.type === 'resize') return;
    } catch (e) { /* not JSON — treat as raw keystroke input below */ }

    if (data === '\r') {
      this._emit('\r\n' + respond(this._buffer) + '\r\n$ ');
      this._buffer = '';
      return;
    }
    if (data === DEL || data === '\b') {
      if (this._buffer.length > 0) {
        this._buffer = this._buffer.slice(0, -1);
        this._emit('\b \b');
      }
      return;
    }
    if (data === CTRL_C) {
      this._buffer = '';
      this._emit('^C\r\n$ ');
      return;
    }
    // Printable input — local echo, since there's no real PTY to do it for us.
    this._buffer += data;
    this._emit(data);
  };

  MockWebSocket.prototype.close = function () {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose({ target: this });
  };

  function PatchedWebSocket(url, protocols) {
    if (isDemoUrl(url)) {
      return new MockWebSocket(url);
    }
    return new RealWebSocket(url, protocols);
  }
  PatchedWebSocket.prototype = RealWebSocket.prototype;
  PatchedWebSocket.CONNECTING = RealWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = RealWebSocket.OPEN;
  PatchedWebSocket.CLOSING = RealWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = RealWebSocket.CLOSED;

  window.WebSocket = PatchedWebSocket;
})();
