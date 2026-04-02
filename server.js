/**
 * Procession Stream - Signaling Server
 * Node.js + WebSocket server for WebRTC peer signaling
 * Handles room management, offer/answer/ICE exchange
 * + Proxies Xirsys TURN credentials so secret stays server-side
 */

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

// Xirsys credentials — override via environment variables in production
const XIRSYS_IDENT   = process.env.XIRSYS_IDENT   || "";
const XIRSYS_SECRET  = process.env.XIRSYS_SECRET   || "";
const XIRSYS_CHANNEL = process.env.XIRSYS_CHANNEL  || "parish";
const XIRSYS_URL     = `https://global.xirsys.net/_turn/${XIRSYS_CHANNEL}`;

/**
 * Fetch fresh ICE credentials from Xirsys.
 * These expire every ~30s so fetch fresh ones per request.
 */
async function fetchXirsysIce() {
  const auth = Buffer.from(`${XIRSYS_IDENT}:${XIRSYS_SECRET}`).toString("base64");
  const res = await fetch(XIRSYS_URL, {
    method: "PUT",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ format: "urls" }),
  });
  if (!res.ok) throw new Error(`Xirsys error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  // Xirsys can return { v: [...] } or { v: { iceServers: [...] } }
  if (!data || !data.v) return [];
  if (Array.isArray(data.v)) return data.v;
  if (Array.isArray(data.v.iceServers)) return data.v.iceServers;
  if (typeof data.v === "object") {
    // Sometimes Xirsys wraps each server as a key
    const servers = Object.values(data.v).flat();
    return Array.isArray(servers) ? servers : [];
  }
  return [];
}

const server = http.createServer(async (req, res) => {
  // CORS headers so the frontend can call /ice-servers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── GET /ice-servers — proxies Xirsys, returns ICE server list ──
  if (req.url === "/ice-servers" && req.method === "GET") {
    try {
      const xirsysServers = await fetchXirsysIce();
      const combined = [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:global.xirsys.net" },
        ...xirsysServers,
      ];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ iceServers: combined }));
      console.log(`[ICE] Served ${combined.length} ICE servers (${xirsysServers.length} from Xirsys):`, JSON.stringify(xirsysServers));
    } catch (err) {
      console.error("[ICE] Xirsys fetch failed:", err.message);
      // Fallback: Google STUN only
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
        ],
      }));
    }
    return;
  }

  // ── GET /health ─────────────────────────────────────────────────
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", rooms: rooms.size }));
    return;
  }

  res.writeHead(200);
  res.end("Procession Stream Signaling Server");
});

const wss = new WebSocketServer({ server });

// rooms: Map<roomCode, { leader: ws | null, followers: Set<ws> }>
const rooms = new Map();

// clientMeta: WeakMap<ws, { roomCode, role, id }>
const clientMeta = new WeakMap();

let clientIdCounter = 0;

function getOrCreateRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, { leader: null, followers: new Set() });
  }
  return rooms.get(roomCode);
}

function cleanupClient(ws) {
  const meta = clientMeta.get(ws);
  if (!meta) return;

  const { roomCode, role } = meta;
  const room = rooms.get(roomCode);
  if (!room) return;

  if (role === "leader") {
    room.leader = null;
    // Notify all followers that leader disconnected
    room.followers.forEach((followerWs) => {
      safeSend(followerWs, { type: "leader-disconnected" });
    });
    console.log(`[Room ${roomCode}] Leader disconnected`);
  } else {
    room.followers.delete(ws);
    // Notify leader that a follower left
    if (room.leader) {
      safeSend(room.leader, { type: "follower-left", followerId: meta.id });
    }
    console.log(`[Room ${roomCode}] Follower ${meta.id} disconnected`);
  }

  // Cleanup empty rooms
  if (!room.leader && room.followers.size === 0) {
    rooms.delete(roomCode);
    console.log(`[Room ${roomCode}] Room deleted (empty)`);
  }
}

function safeSend(ws, data) {
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      console.error("safeSend error:", e.message);
    }
  }
}

wss.on("connection", (ws) => {
  console.log("New WebSocket connection");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type, roomCode } = msg;

    switch (type) {
      // ─── Leader joins / creates room ───────────────────────────────
      case "join-leader": {
        const room = getOrCreateRoom(roomCode);
        if (room.leader && room.leader !== ws) {
          safeSend(ws, { type: "error", message: "Room already has a leader" });
          return;
        }
        room.leader = ws;
        clientMeta.set(ws, { roomCode, role: "leader", id: "leader" });
        safeSend(ws, { type: "joined", role: "leader", roomCode });
        console.log(`[Room ${roomCode}] Leader joined`);
        break;
      }

      // ─── Follower joins room ────────────────────────────────────────
      case "join-follower": {
        const room = getOrCreateRoom(roomCode);
        const followerId = `follower-${++clientIdCounter}`;
        room.followers.add(ws);
        clientMeta.set(ws, { roomCode, role: "follower", id: followerId });
        safeSend(ws, {
          type: "joined",
          role: "follower",
          roomCode,
          followerId,
          leaderPresent: !!room.leader,
        });
        // Tell leader a new follower arrived
        if (room.leader) {
          safeSend(room.leader, { type: "follower-joined", followerId });
        }
        console.log(`[Room ${roomCode}] Follower ${followerId} joined`);
        break;
      }

      // ─── WebRTC Offer (leader → specific follower) ──────────────────
      case "offer": {
        const meta = clientMeta.get(ws);
        if (!meta || meta.role !== "leader") return;
        const room = rooms.get(meta.roomCode);
        if (!room) return;
        room.followers.forEach((followerWs) => {
          const fMeta = clientMeta.get(followerWs);
          if (fMeta && fMeta.id === msg.targetId) {
            safeSend(followerWs, { type: "offer", sdp: msg.sdp });
          }
        });
        break;
      }

      // ─── WebRTC Answer (follower → leader) ─────────────────────────
      case "answer": {
        const meta = clientMeta.get(ws);
        if (!meta || meta.role !== "follower") return;
        const room = rooms.get(meta.roomCode);
        if (!room || !room.leader) return;
        safeSend(room.leader, {
          type: "answer",
          sdp: msg.sdp,
          followerId: meta.id,
        });
        break;
      }

      // ─── ICE Candidate relay ────────────────────────────────────────
      case "ice-candidate": {
        const meta = clientMeta.get(ws);
        if (!meta) return;
        const room = rooms.get(meta.roomCode);
        if (!room) return;

        if (meta.role === "leader") {
          room.followers.forEach((followerWs) => {
            const fMeta = clientMeta.get(followerWs);
            if (fMeta && fMeta.id === msg.targetId) {
              safeSend(followerWs, {
                type: "ice-candidate",
                candidate: msg.candidate,
              });
            }
          });
        } else {
          if (room.leader) {
            safeSend(room.leader, {
              type: "ice-candidate",
              candidate: msg.candidate,
              followerId: meta.id,
            });
          }
        }
        break;
      }

      // ─── Stream state broadcast ─────────────────────────────────────
      case "stream-state": {
        const meta = clientMeta.get(ws);
        if (!meta || meta.role !== "leader") return;
        const room = rooms.get(meta.roomCode);
        if (!room) return;
        room.followers.forEach((followerWs) => {
          safeSend(followerWs, { type: "stream-state", state: msg.state });
        });
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", () => cleanupClient(ws));
  ws.on("error", () => cleanupClient(ws));
});

server.listen(PORT, () => {
  console.log(`Procession Stream Signaling Server running on port ${PORT}`);
  console.log(`Xirsys channel: ${XIRSYS_CHANNEL} (ident: ${XIRSYS_IDENT})`);
});
