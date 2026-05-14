// index.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const PORT = process.env.PORT || 3001;

const app = express();

app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});


// Track which rooms each user is in
const userRooms = {};
const userNames = {};
const roomUsers = {};
// Track playback state for each room
const roomStates = {};

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

io.on("connection", (socket) => {

  console.log("User connected:", socket.id);

  // JOIN ROOM

  socket.on("join-room", (joinData) => {

    const roomId =
      typeof joinData === "string"
        ? joinData.trim()
        : joinData.roomId.trim();

    const username =
      typeof joinData === "string"
        ? socket.id
        : joinData.username.trim();

    if (!roomId) return;

    userNames[socket.id] = username || socket.id;

    socket.join(roomId);

    if (!roomUsers[roomId]) {
      roomUsers[roomId] = {};
    }

    roomUsers[roomId][socket.id] =
      userNames[socket.id];

    // Track user's rooms
    if (!userRooms[socket.id]) {
      userRooms[socket.id] = [];
    }

    if (!userRooms[socket.id].includes(roomId)) {
      userRooms[socket.id].push(roomId);
    }

    console.log(
      `${userNames[socket.id]} joined room ${roomId}`
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

  });

  // PLAY

  socket.on("play", ({
    roomId,
    currentTime,
  }) => {

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

  });

  // PAUSE

  socket.on("pause", ({
    roomId,
    currentTime,
  }) => {

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

  });

  // SEEK

  socket.on("seek", ({
    roomId,
    currentTime,
  }) => {

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

  });

  // CHANGE VIDEO

  socket.on("change-video", ({
    roomId,
    videoUrl,
  }) => {

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

  });

  // SEND MESSAGE

  socket.on("send-message", ({
    roomId,
    message,
  }) => {

    if (!message || !message.trim() || !roomId) return;

    const username = userNames[socket.id] || "Anonymous";

    console.log(
      `${username} sent message in ${roomId}: ${message}`
    );

    io.to(roomId).emit("receive-message", {
      username,
      message: message.trim(),
      timestamp: Date.now(),
    });

  });

  // REQUEST SYNC

  socket.on("request-sync", ({
    roomId,
  }) => {

    console.log(
      `${socket.id} requested sync in ${roomId}`
    );

    socket.to(roomId).emit("request-sync", {
      requesterId: socket.id,
    });

  });

  // SEND SYNC STATE

  socket.on("sync-state", ({
    requesterId,
    currentTime,
    isPlaying,
    videoUrl,
  }) => {

    io.to(requesterId).emit("sync-state", {
      currentTime,
      isPlaying,
      videoUrl,
    });

  });

  // DISCONNECT

  socket.on("disconnecting", () => {

    console.log(
      "User disconnecting:",
      socket.id
    );

    // Clean up user's rooms
    if (userRooms[socket.id]) {
      userRooms[socket.id].forEach((roomId) => {
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
      });
      delete userRooms[socket.id];
    }

    delete userNames[socket.id];

  });

});
