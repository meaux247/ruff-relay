const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const LOBBY_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

// Lobby storage: code -> { host, clients[], names[], settings, created_at }
const lobbies = new Map();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 for readability
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function generateUniqueCode() {
  for (let i = 0; i < 100; i++) {
    const code = generateCode();
    if (!lobbies.has(code)) return code;
  }
  return null;
}

function broadcastToLobby(code, message, excludeWs = null) {
  const lobby = lobbies.get(code);
  if (!lobby) return;
  const data = JSON.stringify(message);
  for (const client of lobby.clients) {
    if (client.ws !== excludeWs && client.ws.readyState === 1) {
      client.ws.send(data);
    }
  }
}

function sendTo(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function getLobbyPlayerList(lobby) {
  return lobby.clients.map((c) => ({
    seat: c.seat,
    name: c.name,
    is_host: c.is_host,
  }));
}

function cleanupLobby(code) {
  const lobby = lobbies.get(code);
  if (!lobby) return;
  for (const client of lobby.clients) {
    if (client.ws.readyState === 1) {
      sendTo(client.ws, { type: "lobby_closed" });
      client.ws.close();
    }
  }
  lobbies.delete(code);
  console.log(`[Lobby ${code}] Cleaned up`);
}

// Periodic cleanup of stale lobbies
setInterval(() => {
  const now = Date.now();
  for (const [code, lobby] of lobbies) {
    if (now - lobby.created_at > LOBBY_TIMEOUT_MS) {
      console.log(`[Lobby ${code}] Expired`);
      cleanupLobby(code);
    }
  }
}, 60000);

// HTTP server for lobby creation and health check
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", lobbies: lobbies.size }));
    return;
  }

  if (req.method === "POST" && req.url === "/create-lobby") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const code = generateUniqueCode();
      if (!code) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Server full" }));
        return;
      }

      let settings = {};
      try {
        if (body) settings = JSON.parse(body);
      } catch (_e) {
        /* ignore */
      }

      lobbies.set(code, {
        clients: [],
        settings: settings,
        game_started: false,
        created_at: Date.now(),
      });

      console.log(`[Lobby ${code}] Created`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code }));
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = url.searchParams.get("code");
  const name = url.searchParams.get("name") || "Player";
  const isHost = url.searchParams.get("host") === "true";

  if (!code || !lobbies.has(code)) {
    sendTo(ws, { type: "error", message: "Invalid lobby code" });
    ws.close();
    return;
  }

  const lobby = lobbies.get(code);

  if (lobby.clients.length >= 4) {
    sendTo(ws, { type: "error", message: "Lobby is full" });
    ws.close();
    return;
  }

  // Assign seat (host gets 0, others get next available)
  let seat;
  if (isHost && lobby.clients.length === 0) {
    seat = 0;
  } else {
    const taken = new Set(lobby.clients.map((c) => c.seat));
    for (let s = 0; s < 4; s++) {
      if (!taken.has(s)) {
        seat = s;
        break;
      }
    }
  }

  const client = {
    ws,
    name,
    seat,
    is_host: isHost && seat === 0,
  };
  lobby.clients.push(client);
  ws._lobbyCode = code;
  ws._seat = seat;
  ws._isHost = client.is_host;

  console.log(
    `[Lobby ${code}] ${name} joined as seat ${seat}${client.is_host ? " (host)" : ""}`
  );

  // Confirm join to the connecting client
  sendTo(ws, {
    type: "joined",
    code,
    seat,
    is_host: client.is_host,
    players: getLobbyPlayerList(lobby),
  });

  // Notify all others
  broadcastToLobby(
    code,
    {
      type: "lobby_update",
      players: getLobbyPlayerList(lobby),
    },
    ws
  );

  // Message handling
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_e) {
      return;
    }

    const senderLobby = lobbies.get(ws._lobbyCode);
    if (!senderLobby) return;

    switch (msg.type) {
      case "start_game":
        // Only host can start
        if (!ws._isHost) return;
        senderLobby.game_started = true;
        broadcastToLobby(ws._lobbyCode, {
          type: "game_start",
          players: getLobbyPlayerList(senderLobby),
          settings: senderLobby.settings,
        });
        console.log(`[Lobby ${ws._lobbyCode}] Game started`);
        break;

      case "game_event":
        // Host broadcasts game events to all clients
        if (!ws._isHost) return;
        broadcastToLobby(ws._lobbyCode, msg);
        break;

      case "game_state":
        // Host sends full state — forward to specific client or all
        if (!ws._isHost) return;
        if (msg.target_seat !== undefined) {
          // Send to specific seat
          const target = senderLobby.clients.find(
            (c) => c.seat === msg.target_seat
          );
          if (target) sendTo(target.ws, msg);
        } else {
          broadcastToLobby(ws._lobbyCode, msg);
        }
        break;

      case "player_action":
        // Client sends action to host
        msg.from_seat = ws._seat; // server stamps the seat (anti-cheat)
        const host = senderLobby.clients.find((c) => c.is_host);
        if (host) sendTo(host.ws, msg);
        break;

      case "chat":
        msg.from_seat = ws._seat;
        msg.from_name = ws._name;
        broadcastToLobby(ws._lobbyCode, msg);
        break;

      default:
        break;
    }
  });

  ws.on("close", () => {
    const lobbyCode = ws._lobbyCode;
    const closingLobby = lobbies.get(lobbyCode);
    if (!closingLobby) return;

    closingLobby.clients = closingLobby.clients.filter((c) => c.ws !== ws);
    console.log(
      `[Lobby ${lobbyCode}] Player seat ${ws._seat} disconnected (${closingLobby.clients.length} remain)`
    );

    if (closingLobby.clients.length === 0) {
      cleanupLobby(lobbyCode);
    } else {
      // Notify remaining players
      broadcastToLobby(lobbyCode, {
        type: "player_disconnected",
        seat: ws._seat,
        players: getLobbyPlayerList(closingLobby),
      });

      // If host left, promote next player or close
      if (ws._isHost && closingLobby.clients.length > 0) {
        // For now, close the lobby if host leaves
        broadcastToLobby(lobbyCode, {
          type: "error",
          message: "Host disconnected",
        });
        cleanupLobby(lobbyCode);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Ruff relay server running on port ${PORT}`);
});
