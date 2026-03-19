const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss  = new WebSocket.Server({ port: PORT });

console.log(`Derby Dynasty relay running on port ${PORT}`);

// rooms: code -> { host_id, host_name, is_public, player_count, clients: Map(pid -> ws) }
const rooms = new Map();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function closeRoom(code, reason = "Host left") {
  const room = rooms.get(code);
  if (!room) return;
  for (const [, ws] of room.clients) {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "ROOM_CLOSED", reason }));
  }
  rooms.delete(code);
  console.log(`Room ${code} closed: ${reason}`);
}

function markAlive(ws) {
  ws.isAlive  = true;
  ws.lastSeen = Date.now();
}

function getPublicLobbies() {
  const list = [];
  for (const [code, room] of rooms) {
    if (room.is_public) {
      list.push({
        code,
        host_name:    room.host_name,
        player_count: room.clients.size,
        max_players:  6,
      });
    }
  }
  return list;
}

wss.on("connection", (ws) => {
  ws.player_id = null;
  ws.room_code = null;
  ws.isAlive   = true;
  ws.lastSeen  = Date.now();

  ws.on("pong", () => markAlive(ws));

  ws.on("message", (raw) => {
    markAlive(ws);
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const type = msg.type || "";

    // ── KEEPALIVE ──────────────────────────────────────────
    if (type === "PING") {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "PONG" }));
      return;
    }

    // ── PUBLIC LOBBY LIST ──────────────────────────────────
    if (type === "LIST_LOBBIES") {
      ws.send(JSON.stringify({ type: "LOBBY_LIST", lobbies: getPublicLobbies() }));
      return;
    }

    // ── CREATE ROOM ────────────────────────────────────────
    if (type === "CREATE_ROOM") {
      const pid       = msg.player_id;
      const is_public = msg.public === true;
      let code;
      do { code = generateCode(); } while (rooms.has(code));
      rooms.set(code, {
        host_id:      pid,
        host_name:    msg.name || "???",
        is_public,
        clients:      new Map([[pid, ws]])
      });
      ws.player_id = pid;
      ws.room_code = code;
      ws.send(JSON.stringify({ type: "ROOM_CREATED", code, is_public }));
      console.log(`Room ${code} created by ${pid} (${is_public ? "public" : "private"})`);
      return;
    }

    // ── JOIN ROOM ──────────────────────────────────────────
    if (type === "JOIN_ROOM") {
      const code = (msg.code || "").toUpperCase().trim();
      const pid  = msg.player_id;
      const name = msg.name || "???";
      const room = rooms.get(code);
      if (!room) { ws.send(JSON.stringify({ type: "JOIN_ERROR", reason: "Room not found" })); return; }
      if (room.clients.size >= 6) { ws.send(JSON.stringify({ type: "JOIN_ERROR", reason: "Room is full (max 6)" })); return; }
      room.clients.set(pid, ws);
      ws.player_id = pid;
      ws.room_code = code;
      ws.send(JSON.stringify({ type: "JOIN_OK", code }));
      for (const [id, client] of room.clients)
        if (id !== pid && client.readyState === WebSocket.OPEN)
          client.send(JSON.stringify({ type: "PLAYER_JOINED", player_id: pid, name }));
      console.log(`${pid} joined room ${code}`);
      return;
    }

    // ── LEAVE ROOM ─────────────────────────────────────────
    if (type === "LEAVE_ROOM") {
      const pid  = msg.player_id || ws.player_id;
      const code = ws.room_code;
      if (!code) return;
      const room = rooms.get(code);
      if (!room) return;
      if (room.host_id === pid) {
        closeRoom(code, "Host left");
      } else {
        room.clients.delete(pid);
        for (const [, client] of room.clients)
          if (client.readyState === WebSocket.OPEN)
            client.send(JSON.stringify({ type: "PLAYER_LEFT", player_id: pid }));
      }
      return;
    }

    // ── ROUTED MESSAGES ────────────────────────────────────
    const code = ws.room_code;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const route = msg.route || "";

    if (route === "host_to_all") {
      const out = JSON.stringify(msg);
      for (const [, client] of room.clients)
        if (client !== ws && client.readyState === WebSocket.OPEN) client.send(out);
    } else if (route === "to_host") {
      const host_ws = room.clients.get(room.host_id);
      if (host_ws && host_ws.readyState === WebSocket.OPEN) {
        msg._from_id = ws.player_id;
        host_ws.send(JSON.stringify(msg));
      }
    } else {
      const out = JSON.stringify(msg);
      for (const [, client] of room.clients)
        if (client !== ws && client.readyState === WebSocket.OPEN) client.send(out);
    }
  });

  ws.on("close", () => {
    const pid = ws.player_id, code = ws.room_code;
    if (!code || !pid) return;
    const room = rooms.get(code);
    if (!room) return;
    if (room.host_id === pid) {
      closeRoom(code, "Host disconnected");
    } else {
      room.clients.delete(pid);
      for (const [, client] of room.clients)
        if (client.readyState === WebSocket.OPEN)
          client.send(JSON.stringify({ type: "PLAYER_LEFT", player_id: pid }));
    }
  });

  ws.on("error", (err) => console.error(`WS error for ${ws.player_id}: ${err.message}`));
});

// ── Heartbeat ────────────────────────────────────────────────
const heartbeat = setInterval(() => {
  const now = Date.now();
  wss.clients.forEach((ws) => {
    if (!ws.isAlive && (now - (ws.lastSeen || now)) > 45000) {
      console.log(`Terminating dead client ${ws.player_id}`);
      ws.terminate(); return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

wss.on("close", () => clearInterval(heartbeat));