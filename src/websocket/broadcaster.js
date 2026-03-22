// Map: userId -> Set<WebSocket>
const userConnections = new Map();
// Map: room -> Set<WebSocket>
const roomConnections = new Map();

function registerUser(userId, ws) {
  if (!userConnections.has(userId)) userConnections.set(userId, new Set());
  userConnections.get(userId).add(ws);
}

function unregisterUser(userId, ws) {
  if (userConnections.has(userId)) {
    userConnections.get(userId).delete(ws);
    if (userConnections.get(userId).size === 0) userConnections.delete(userId);
  }
}

function joinRoom(room, ws) {
  if (!roomConnections.has(room)) roomConnections.set(room, new Set());
  roomConnections.get(room).add(ws);
}

function leaveRoom(room, ws) {
  if (roomConnections.has(room)) {
    roomConnections.get(room).delete(ws);
  }
}

function broadcastToUser(userId, payload) {
  const conns = userConnections.get(userId);
  if (!conns) return;
  const msg = JSON.stringify(payload);
  for (const ws of conns) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function broadcastToRoom(room, payload) {
  const conns = roomConnections.get(room);
  if (!conns) return;
  const msg = JSON.stringify(payload);
  for (const ws of conns) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function broadcastAll(payload) {
  const msg = JSON.stringify(payload);
  for (const conns of userConnections.values()) {
    for (const ws of conns) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }
}

function getOnlineCount() {
  return userConnections.size;
}

module.exports = { registerUser, unregisterUser, joinRoom, leaveRoom, broadcastToUser, broadcastToRoom, broadcastAll, getOnlineCount };
