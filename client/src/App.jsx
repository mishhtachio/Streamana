import { useEffect, useRef, useState } from "react";
import YouTube from "react-youtube";
import { socket } from "./socket";
import "./App.css";

function App() {

  const [username, setUsername] = useState("");
  const [hasUsername, setHasUsername] = useState(false);

  const [roomId, setRoomId] = useState("");
  const [joinedRoom, setJoinedRoom] = useState("");
  const [roomUsers, setRoomUsers] = useState([]);

  const [videoUrl, setVideoUrl] = useState("");

  const [activeVideo, setActiveVideo] = useState(
    "https://www.w3schools.com/html/mov_bbb.mp4"
  );

  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");

  const [clock, setClock] = useState("");

  const videoRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const embedPlayerRef = useRef(null);
  const isRemoteAction = useRef(false);
  const pendingSyncState = useRef(null);
  const youtubeTimeTracker = useRef({ time: 0, checkedAt: Date.now() });
  const lastControlEmitAt = useRef(0);
  const messagesEndRef = useRef(null);

  // Live clock
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const isEmbedVideo =
    activeVideo.includes("/embed/") || activeVideo.includes("embed");

  const getYoutubeVideoId = (url) => {
    if (!url) return null;
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.hostname === "youtu.be") return parsedUrl.pathname.slice(1);
      if (parsedUrl.searchParams.get("v")) return parsedUrl.searchParams.get("v");
      if (parsedUrl.pathname.includes("/embed/")) return parsedUrl.pathname.split("/embed/")[1];
      if (parsedUrl.pathname.includes("/shorts/")) return parsedUrl.pathname.split("/shorts/")[1];
      return null;
    } catch {
      return null;
    }
  };

  const isYoutubeVideo = getYoutubeVideoId(activeVideo) !== null;

  const suppressLocalEvents = () => {
    isRemoteAction.current = true;
    window.clearTimeout(suppressLocalEvents.timeoutId);
    suppressLocalEvents.timeoutId = window.setTimeout(() => {
      isRemoteAction.current = false;
    }, 700);
  };

  const canEmitControl = () => {
    const now = Date.now();
    if (now - lastControlEmitAt.current < 250) return false;
    lastControlEmitAt.current = now;
    return true;
  };

  const getCurrentTime = () => {
    if (isYoutubeVideo && youtubePlayerRef.current) return youtubePlayerRef.current.getCurrentTime();
    if (videoRef.current) return videoRef.current.currentTime;
    return 0;
  };

  const emitPlaybackControl = (type, currentTime = getCurrentTime()) => {
    if (!joinedRoom || isRemoteAction.current) return;
    if (!canEmitControl()) return;
    socket.emit(type, { roomId: joinedRoom, currentTime });
  };

  const applySyncState = ({ currentTime, isPlaying }) => {
    suppressLocalEvents();

    if (isEmbedVideo) {
      if (!embedPlayerRef.current || !embedPlayerRef.current.contentWindow) {
        pendingSyncState.current = { currentTime, isPlaying };
        return false;
      }
      try {
        embedPlayerRef.current.contentWindow.postMessage({ type: "PLAYER_SEEK", currentTime }, "*");
        embedPlayerRef.current.contentWindow.postMessage({ type: isPlaying ? "PLAYER_PLAY" : "PLAYER_PAUSE" }, "*");
      } catch (e) {}
      pendingSyncState.current = null;
      return true;
    }

    if (isYoutubeVideo) {
      if (!youtubePlayerRef.current) return false;
      youtubePlayerRef.current.seekTo(currentTime, true);
      youtubeTimeTracker.current = { time: currentTime, checkedAt: Date.now() };
      if (isPlaying) youtubePlayerRef.current.playVideo();
      else youtubePlayerRef.current.pauseVideo();
      return true;
    }

    if (!videoRef.current) return false;
    if (videoRef.current.readyState < 1) return false;
    videoRef.current.currentTime = currentTime;
    if (isPlaying) videoRef.current.play().catch(() => {});
    else videoRef.current.pause();
    return true;
  };

  useEffect(() => {
    const queueSyncState = (syncState) => {
      if (!syncState) return;
      setActiveVideo(syncState.videoUrl);
      const latencySeconds = syncState.isPlaying && syncState.sentAt
        ? (Date.now() - syncState.sentAt) / 1000 : 0;
      pendingSyncState.current = {
        currentTime: (syncState.currentTime || 0) + latencySeconds,
        isPlaying: Boolean(syncState.isPlaying),
      };
      if (videoRef.current) videoRef.current.load();
      if (syncState.videoUrl === activeVideo) {
        if (applySyncState(pendingSyncState.current)) pendingSyncState.current = null;
      }
    };

    socket.on("joined-room", ({ roomId, users, state }) => {
      setJoinedRoom(roomId);
      setRoomUsers(users || []);
      queueSyncState(state);
    });

    socket.on("sync-state", ({ currentTime, isPlaying, videoUrl }) => {
      queueSyncState({ currentTime, isPlaying, videoUrl });
    });

    socket.on("room-users", (users) => setRoomUsers(users));

    socket.on("receive-message", ({ username, message, timestamp }) => {
      setMessages((prev) => [...prev, { username, message, timestamp }]);
    });

    return () => {
      socket.off("joined-room");
      socket.off("sync-state");
      socket.off("room-users");
      socket.off("receive-message");
    };
  }, [activeVideo, isEmbedVideo, isYoutubeVideo]);

  useEffect(() => {
    if (!pendingSyncState.current) return;
    if (applySyncState(pendingSyncState.current)) pendingSyncState.current = null;
  }, [activeVideo, isYoutubeVideo]);

  useEffect(() => {
    if (!joinedRoom || !isYoutubeVideo) return;
    const intervalId = window.setInterval(() => {
      if (!youtubePlayerRef.current || isRemoteAction.current) return;
      const currentTime = youtubePlayerRef.current.getCurrentTime();
      const playerState = youtubePlayerRef.current.getPlayerState?.();
      const isPlaying = playerState === 1;
      const now = Date.now();
      const previous = youtubeTimeTracker.current;
      const elapsed = (now - previous.checkedAt) / 1000;
      const expectedDelta = isPlaying ? elapsed : 0;
      const actualDelta = currentTime - previous.time;
      if (Math.abs(actualDelta - expectedDelta) > 1.75) emitPlaybackControl("seek", currentTime);
      youtubeTimeTracker.current = { time: currentTime, checkedAt: now };
    }, 700);
    return () => window.clearInterval(intervalId);
  }, [joinedRoom, isYoutubeVideo]);

  const continueToRoom = () => {
    if (!username.trim()) return;
    setUsername(username.trim());
    setHasUsername(true);
  };

  const joinRoom = () => {
    if (!roomId.trim() || !username.trim()) return;
    socket.emit("join-room", { roomId: roomId.trim(), username: username.trim() });
  };

  const loadVideo = () => {
    if (!videoUrl) return;
    setActiveVideo(videoUrl);
    socket.emit("change-video", { roomId: joinedRoom, videoUrl });
  };

  const sendMessage = () => {
    if (!messageInput.trim() || !joinedRoom) return;
    socket.emit("send-message", { roomId: joinedRoom, message: messageInput.trim() });
    setMessageInput("");
  };

  const goBack = () => {
    setJoinedRoom("");
    setRoomUsers([]);
    setMessages([]);
    setMessageInput("");
  };

  return (
    <div className="desktop">

      {/* DESKTOP ICONS */}
      <div className="desktop-icon">
        🖥️<span>My Computer</span>
      </div>
      <div className="desktop-icon second">
        🗑️<span>Recycle Bin</span>
      </div>
      <div className="desktop-icon third">
        📁<span>My Documents</span>
      </div>
      <div className="desktop-icon fourth">
        🎵<span>My Music</span>
      </div>

      {/* MAIN WINDOW */}
      <div className="window">

        {/* TITLE BAR */}
        <div className="title-bar">
          <div className="title-left">
            <span className="title-icon">💿</span>
            Streamana — {joinedRoom ? `Room: ${joinedRoom}` : "Sign In"}
          </div>
          {joinedRoom ? (
            <div className="back-buttons">
              <button onClick={goBack}>← Back</button>
            </div>
          ) : (
            <div className="window-buttons">
              <button title="Minimize">—</button>
              <button title="Maximize">□</button>
              <button title="Close">✕</button>
            </div>
          )}
        </div>

        {/* MENU BAR */}
        <div className="menu-bar">
          <span>File</span>
          <span>Edit</span>
          <span>Actions</span>
          <span>Tools</span>
          <span>Help</span>
        </div>

        {/* TOOLBAR */}
        {joinedRoom && (
          <div className="toolbar">
            <button className="toolbar-btn">
              <span className="tb-icon">👤</span>Invite
            </button>
            <button className="toolbar-btn">
              <span className="tb-icon">📁</span>Send Files
            </button>
            <div className="toolbar-sep" />
            <button className="toolbar-btn">
              <span className="tb-icon">🎬</span>Video
            </button>
            <button className="toolbar-btn">
              <span className="tb-icon">🎙️</span>Voice
            </button>
            <div className="toolbar-sep" />
            <button className="toolbar-btn">
              <span className="tb-icon">🎮</span>Games
            </button>
          </div>
        )}

        {/* CONTENT */}
        <div className="window-content">

          {!joinedRoom ? (

            /* ── JOIN SCREEN ── */
            <div className="join-screen">

              <div className="big-logo">
                <div className="logo-text">Streamana XP</div>
              </div>

              <div className="join-panel">
                <div className="join-panel-header">
                  <span>💿</span>
                  {!hasUsername ? "Enter your display name" : "Join a watch room"}
                </div>
                <div className="join-panel-body">
                  {!hasUsername ? (
                    <>
                      <div>
                        <div className="field-label">Display name:</div>
                        <input
                          type="text"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && continueToRoom()}
                          className="win95-input"
                          placeholder="e.g. CillBipher"
                        />
                      </div>
                      <button className="win95-button primary" onClick={continueToRoom}>
                        Sign In →
                      </button>
                    </>
                  ) : (
                    <>
                      <div>
                        <div className="field-label">Room name:</div>
                        <input
                          type="text"
                          value={roomId}
                          onChange={(e) => setRoomId(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                          className="win95-input"
                          placeholder="Enter room code..."
                        />
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="win95-button" onClick={() => setHasUsername(false)}>
                          ← Back
                        </button>
                        <button className="win95-button primary" style={{ flex: 1 }} onClick={joinRoom}>
                          Connect to Room
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

            </div>

          ) : (

            /* ── PLAYER LAYOUT ── */
            <div className="player-layout">

              {/* LEFT SIDEBAR */}
              <div className="sidebar">

                {/* Current Room */}
                <div className="mini-window">
                  <div className="mini-title">🔗 Current Room</div>
                  <div className="mini-body">
                    <div className="room-name-display">{joinedRoom}</div>
                  </div>
                </div>

                {/* Users */}
                <div className="mini-window">
                  <div className="mini-title">👥 In Room</div>
                  <div className="mini-body" style={{ padding: 0 }}>
                    <div className="user-section-label">Online ({roomUsers.length})</div>
                    <div className="users-list">
                      {roomUsers.map((user) => (
                        <div className="user-row" key={user.id}>
                          <div className="user-avatar">👤</div>
                          <div className="user-status" />
                          <span>{user.username}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Load Media */}
                <div className="mini-window">
                  <div className="mini-title">📺 Load Media</div>
                  <div className="mini-body">
                    <input
                      type="text"
                      placeholder="Paste video URL..."
                      value={videoUrl}
                      onChange={(e) => setVideoUrl(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && loadVideo()}
                      className="win95-input"
                    />
                    <button className="win95-button primary" onClick={loadVideo}>
                      Load ▶
                    </button>
                  </div>
                </div>

                {/* Chat */}
                <div className="mini-window">
                  <div className="mini-title">💬 Chat — {joinedRoom}</div>
                  <div className="mini-body chat-window">
                    <div className="messages-container">
                      {messages.length === 0 && (
                        <div className="chat-italic">No messages yet. Say hi!</div>
                      )}
                      {messages.map((msg, idx) => (
                        <div key={idx} className="chat-message">
                          <span
                            className={
                              "chat-username" +
                              (msg.username === username ? " self" : "")
                            }
                          >
                            {msg.username}:
                          </span>
                          <span className="chat-text"> {msg.message}</span>
                        </div>
                      ))}
                      <div ref={messagesEndRef} />
                    </div>
                    <div className="chat-input-row">
                      <input
                        type="text"
                        placeholder="Type a message..."
                        value={messageInput}
                        onChange={(e) => setMessageInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                        className="win95-input chat-input"
                      />
                      <button className="send-button" onClick={sendMessage}>
                        Send
                      </button>
                    </div>
                    <div className="last-seen">
                      Room: {joinedRoom} · {roomUsers.length} online
                    </div>
                  </div>
                </div>

              </div>

              {/* MEDIA PLAYER */}
              <div className="media-window">
                <div className="media-header">
                  Now Playing:
                </div>

                <div className="media-body">
                  {isEmbedVideo ? (
                    <iframe
                      ref={embedPlayerRef}
                      src={activeVideo}
                      className="embed-player"
                      frameBorder="0"
                      allowFullScreen
                      onLoad={() => {
                        if (pendingSyncState.current && applySyncState(pendingSyncState.current)) {
                          pendingSyncState.current = null;
                        }
                      }}
                    />
                  ) : isYoutubeVideo ? (
                    <YouTube
                      videoId={getYoutubeVideoId(activeVideo)}
                      className="youtube-player"
                      opts={{ width: "100%", height: "100%", playerVars: { autoplay: 0 } }}
                      onReady={(event) => {
                        youtubePlayerRef.current = event.target;
                        if (pendingSyncState.current && applySyncState(pendingSyncState.current)) {
                          pendingSyncState.current = null;
                        }
                      }}
                      onPlay={() => { if (!isRemoteAction.current) emitPlaybackControl("play"); }}
                      onPause={() => { if (!isRemoteAction.current) emitPlaybackControl("pause"); }}
                      onError={(err) => {
                        console.log("Youtube Player Error:", err);
                        alert("This YouTube video cannot be embedded.");
                      }}
                    />
                  ) : (
                    <video
                      ref={videoRef}
                      className="retro-video"
                      controls
                      onPlay={() => { if (!isRemoteAction.current) emitPlaybackControl("play"); }}
                      onPause={() => { if (!isRemoteAction.current) emitPlaybackControl("pause"); }}
                      onSeeked={() => {
                        if (!isRemoteAction.current) emitPlaybackControl("seek", videoRef.current.currentTime);
                      }}
                      onLoadedMetadata={() => {
                        if (pendingSyncState.current && applySyncState(pendingSyncState.current)) {
                          pendingSyncState.current = null;
                        }
                      }}
                    >
                      <source src={activeVideo} type="video/mp4" />
                    </video>
                  )}
                </div>

                <div className="status-bar">
                  <div className="status-segment">
                    <div className="status-dot" />
                    {username} connected
                  </div>
                  <div className="status-segment">
                    Room :: {joinedRoom}
                  </div>
                  <div className="status-segment">
                    {roomUsers.length} user{roomUsers.length !== 1 ? "s" : ""} watching
                  </div>
                </div>
              </div>

            </div>

          )}

        </div>
      </div>

      {/* TASKBAR */}
      <div className="taskbar">
        <button className="start-button">
          🪟 start
        </button>
        <div className="taskbar-sep" />
        <div className="taskbar-app">
          💿 Streamana
        </div>
        {joinedRoom && (
          <div className="taskbar-app">
            💬 {username} — Conversation
          </div>
        )}
        <div className="system-tray">
          <span className="tray-icon" title="Network">🌐</span>
          <span className="tray-icon" title="Volume">🔊</span>
          <span className="tray-icon" title="MSN">💬</span>
          <div className="clock">{clock}</div>
        </div>
      </div>

    </div>
  );
}

export default App;