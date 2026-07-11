// index.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const PORT = process.env.PORT || 3001;

const app = express();

const ALLOWED_ORIGINS = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(",")
  : ["http://localhost:5173", "http://localhost:3000", "https://streamana.vercel.app"];

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(helmet());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
  },
  maxHttpBufferSize: 1e4, // 10 KB max payload
});

server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});


// Track which rooms each user is in
// Use Object.create(null) to prevent prototype pollution (Issue #3)
const userRooms = Object.create(null);
const userNames = Object.create(null);
const roomUsers = Object.create(null);
// Track playback state for each room
const roomStates = Object.create(null);

// --- Security Limits ---

const MAX_ROOMS = 500;
const MAX_USERNAME_LENGTH = 30;
const MAX_CONNECTIONS_PER_IP = 10;
const connectionCounts = Object.create(null);

const sanitizeForLog = (str, maxLen = 50) =>
  typeof str === "string" ? str.slice(0, maxLen).replace(/[\n\r]/g, " ") : "[invalid]";

// --- Validation Helpers (Issue #1) ---

const DANGEROUS_KEYS = new Set([
  "__proto__", "constructor", "prototype",
  "toString", "valueOf", "hasOwnProperty",
]);

const isValidRoomId = (roomId) => {
  if (typeof roomId !== "string") return false;
  const trimmed = roomId.trim();
  if (!trimmed || trimmed.length > 100) return false;
  if (DANGEROUS_KEYS.has(trimmed)) return false;
  return true;
};

const isValidString = (str, maxLength = 500) => {
  return typeof str === "string" &&
    str.trim().length > 0 &&
    str.length <= maxLength;
};

const isValidNumber = (num) => {
  return typeof num === "number" &&
    Number.isFinite(num) &&
    num >= 0;
};

const isValidVideoUrl = (url) => {
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
};

// Wraps every socket handler so a malformed payload can never crash the server (Issue #1)
const safeHandler = (handler) => (...args) => {
  try {
    handler(...args);
  } catch (err) {
    console.error("Socket handler error:", err.message);
  }
};

// --- Rate Limiting (Issue #7) ---

const RATE_LIMITS = {
  "send-message": { windowMs: 1000, max: 3 },
  "change-video": { windowMs: 5000, max: 2 },
  "play": { windowMs: 500, max: 3 },
  "pause": { windowMs: 500, max: 3 },
  "seek": { windowMs: 500, max: 5 },
};

const rateLimitState = Object.create(null);

const checkRateLimit = (socketId, eventName) => {
  const config = RATE_LIMITS[eventName];
  if (!config) return true;

  const key = `${socketId}:${eventName}`;
  const now = Date.now();

  if (!rateLimitState[key]) {
    rateLimitState[key] = { timestamps: [now] };
    return true;
  }

  const state = rateLimitState[key];
  state.timestamps = state.timestamps.filter(
    (t) => now - t < config.windowMs
  );

  if (state.timestamps.length >= config.max) {
    return false;
  }

  state.timestamps.push(now);
  return true;
};

// --- Room Helpers ---

const getRoomUsers = (roomId) =>
  Object.entries(roomUsers[roomId] || {}).map(([
    id,
    username,
  ]) => ({
    id,
    username,
  }));

const broadcastRoomUsers = (roomId) => {
  io.to(roomId).emit(
    "room-users",
    getRoomUsers(roomId)
  );
};

const getRoomState = (roomId) => {
  const roomState = roomStates[roomId];

  if (!roomState) return null;

  let currentTime = roomState.currentTime;

  if (roomState.isPlaying && roomState.playStartTime) {
    currentTime +=
      (Date.now() - roomState.playStartTime) / 1000;
  }

  return {
    currentTime,
    isPlaying: roomState.isPlaying,
    sentAt: Date.now(),
    videoUrl: roomState.videoUrl,
  };
};

// Centralised room-leave logic used by leave-room, join-room, and disconnect (Issue #2)
const leaveRoom = (socket, roomId) => {
  socket.leave(roomId);

  if (roomUsers[roomId]) {
    delete roomUsers[roomId][socket.id];
  }

  const room = io.sockets.adapter.rooms.get(roomId);
  const remainingUsers =
    room && room.has(socket.id)
      ? room.size - 1
      : room?.size || 0;

  if (remainingUsers === 0) {
    delete roomStates[roomId];
    delete roomUsers[roomId];
  } else {
    broadcastRoomUsers(roomId);
  }
};

const leaveAllRooms = (socket) => {
  if (userRooms[socket.id]) {
    userRooms[socket.id].forEach((roomId) => {
      leaveRoom(socket, roomId);
    });
    delete userRooms[socket.id];
  }
};

// --- Connection Limiting ---

io.use((socket, next) => {
  const ip = socket.handshake.address;
  connectionCounts[ip] = (connectionCounts[ip] || 0) + 1;
  if (connectionCounts[ip] > MAX_CONNECTIONS_PER_IP) {
    return next(new Error("Too many connections"));
  }
  next();
});

// --- Socket Connection ---

io.on("connection", (socket) => {

  console.log("User connected:", socket.id);

  // JOIN ROOM

  socket.on("join-room", safeHandler((joinData) => {

    if (!joinData) return;

    const roomId =
      typeof joinData === "string"
        ? joinData.trim()
        : (joinData.roomId
          ? String(joinData.roomId).trim()
          : "");

    const username =
      typeof joinData === "string"
        ? socket.id
        : (joinData.username
          ? String(joinData.username).trim()
          : socket.id);

    if (!isValidRoomId(roomId)) return;
    if (username.length > MAX_USERNAME_LENGTH) return;

    // Enforce max room limit (H5)
    if (!roomStates[roomId] && Object.keys(roomStates).length >= MAX_ROOMS) return;

    // Leave all previously joined rooms before joining a new one (Issue #2)
    leaveAllRooms(socket);

    userNames[socket.id] = username || socket.id;

    socket.join(roomId);

    if (!roomUsers[roomId]) {
      roomUsers[roomId] = Object.create(null);
    }

    roomUsers[roomId][socket.id] =
      userNames[socket.id];

    // Track user's rooms (single room at a time now)
    userRooms[socket.id] = [roomId];

    console.log(
      `${sanitizeForLog(userNames[socket.id])} joined room ${sanitizeForLog(roomId)}`
    );

    // Initialize room state if it doesn't exist
    if (!roomStates[roomId]) {
      roomStates[roomId] = {
        videoUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
        currentTime: 0,
        isPlaying: false,
        lastUpdateTime: Date.now(),
        playStartTime: null,
      };
    }

    // Send current room state to the joining user
    socket.emit("joined-room", {
      roomId,
      users: getRoomUsers(roomId),
      state: getRoomState(roomId),
    });

    socket.emit("sync-state", getRoomState(roomId));

    broadcastRoomUsers(roomId);

  }));

  // LEAVE ROOM (Issue #2 — explicit leave event)

  socket.on("leave-room", safeHandler((data) => {

    if (!data) return;

    const roomId =
      typeof data === "string"
        ? data.trim()
        : (data.roomId
          ? String(data.roomId).trim()
          : "");

    if (!isValidRoomId(roomId)) return;

    console.log(
      `${sanitizeForLog(userNames[socket.id] || socket.id)} left room ${sanitizeForLog(roomId)}`
    );

    leaveRoom(socket, roomId);

    if (userRooms[socket.id]) {
      userRooms[socket.id] = userRooms[socket.id].filter(
        (r) => r !== roomId
      );
      if (userRooms[socket.id].length === 0) {
        delete userRooms[socket.id];
      }
    }

  }));

  // PLAY

  socket.on("play", safeHandler((data) => {

    if (!data || typeof data !== "object") return;
    const { roomId, currentTime } = data;

    if (!isValidRoomId(roomId)) return;
    if (!isValidNumber(currentTime)) return;
    if (!checkRateLimit(socket.id, "play")) return;

    console.log(
      `${socket.id} played video in ${roomId}`
    );

    // Update room state
    if (roomStates[roomId]) {
      roomStates[roomId].isPlaying = true;
      roomStates[roomId].currentTime = currentTime;
      roomStates[roomId].playStartTime = Date.now();
      roomStates[roomId].lastUpdateTime = Date.now();
    }

    io.to(roomId).emit(
      "sync-state",
      getRoomState(roomId)
    );

  }));

  // PAUSE

  socket.on("pause", safeHandler((data) => {

    if (!data || typeof data !== "object") return;
    const { roomId, currentTime } = data;

    if (!isValidRoomId(roomId)) return;
    if (!isValidNumber(currentTime)) return;
    if (!checkRateLimit(socket.id, "pause")) return;

    console.log(
      `${socket.id} paused video in ${roomId}`
    );

    // Update room state
    if (roomStates[roomId]) {
      roomStates[roomId].isPlaying = false;
      roomStates[roomId].currentTime = currentTime;
      roomStates[roomId].playStartTime = null;
      roomStates[roomId].lastUpdateTime = Date.now();
    }

    io.to(roomId).emit(
      "sync-state",
      getRoomState(roomId)
    );

  }));

  // SEEK

  socket.on("seek", safeHandler((data) => {

    if (!data || typeof data !== "object") return;
    const { roomId, currentTime } = data;

    if (!isValidRoomId(roomId)) return;
    if (!isValidNumber(currentTime)) return;
    if (!checkRateLimit(socket.id, "seek")) return;

    console.log(
      `${socket.id} seeked video in ${roomId}`
    );

    // Update room state
    if (roomStates[roomId]) {
      roomStates[roomId].currentTime = currentTime;
      // Reset playStartTime when seeking to recalculate elapsed time from new position
      if (roomStates[roomId].isPlaying) {
        roomStates[roomId].playStartTime = Date.now();
      }
      roomStates[roomId].lastUpdateTime = Date.now();
    }

    io.to(roomId).emit(
      "sync-state",
      getRoomState(roomId)
    );

  }));

  // CHANGE VIDEO

  socket.on("change-video", safeHandler((data) => {

    if (!data || typeof data !== "object") return;
    const { roomId, videoUrl } = data;

    if (!isValidRoomId(roomId)) return;
    if (!isValidVideoUrl(videoUrl)) return;
    if (!checkRateLimit(socket.id, "change-video")) return;

    console.log(
      `${socket.id} changed video in ${roomId}`
    );

    // Update room state
    if (roomStates[roomId]) {
      roomStates[roomId].videoUrl = videoUrl;
      roomStates[roomId].currentTime = 0;
      roomStates[roomId].isPlaying = false;
      roomStates[roomId].playStartTime = null;
    }

    io.to(roomId).emit(
      "sync-state",
      getRoomState(roomId)
    );

  }));

  // SEND MESSAGE

  socket.on("send-message", safeHandler((data) => {

    if (!data || typeof data !== "object") return;
    const { roomId, message } = data;

    if (!isValidRoomId(roomId)) return;
    if (!isValidString(message, 2000)) return;
    if (!checkRateLimit(socket.id, "send-message")) return;

    const username = userNames[socket.id] || "Anonymous";

    console.log(
      `${sanitizeForLog(username)} sent message in ${sanitizeForLog(roomId)}`
    );

    io.to(roomId).emit("receive-message", {
      username,
      message: message.trim(),
      timestamp: Date.now(),
    });

  }));

  // REQUEST SYNC

  socket.on("request-sync", safeHandler((data) => {

    if (!data || typeof data !== "object") return;
    const { roomId } = data;

    if (!isValidRoomId(roomId)) return;

    console.log(
      `${socket.id} requested sync in ${roomId}`
    );

    socket.to(roomId).emit("request-sync", {
      requesterId: socket.id,
    });

  }));

  // SEND SYNC STATE

  socket.on("sync-state", safeHandler((data) => {

    if (!data || typeof data !== "object") return;
    const { requesterId, currentTime, isPlaying, videoUrl } = data;

    if (!requesterId || typeof requesterId !== "string") return;

    // Validate sender and target share a room (M5)
    const senderRooms = userRooms[socket.id] || [];
    const targetRooms = userRooms[requesterId] || [];
    const sharedRoom = senderRooms.some((r) => targetRooms.includes(r));
    if (!sharedRoom) return;

    io.to(requesterId).emit("sync-state", {
      currentTime,
      isPlaying,
      videoUrl,
    });

  }));

  // DISCONNECT

  socket.on("disconnecting", safeHandler(() => {

    console.log(
      "User disconnecting:",
      socket.id
    );

    // Clean up user's rooms
    leaveAllRooms(socket);

    delete userNames[socket.id];

    // Clean up rate limit state for this socket
    for (const key of Object.keys(rateLimitState)) {
      if (key.startsWith(socket.id + ":")) {
        delete rateLimitState[key];
      }
    }

    // Decrement connection count for this IP
    const ip = socket.handshake.address;
    if (connectionCounts[ip]) {
      connectionCounts[ip]--;
      if (connectionCounts[ip] <= 0) delete connectionCounts[ip];
    }

  }));

});
