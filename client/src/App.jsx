import { Component, useEffect, useRef, useState } from "react";
import YouTube from "react-youtube";
import { socket } from "./socket";
import "./App.css";

// Error Boundary to prevent blank blue-screen crashes
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("Streamana crashed:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="desktop">
          <div className="window" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <div className="title-bar" style={{ width: "100%" }}>
              <div className="title-left">
                <span className="title-icon">💿</span>
                Streamana — Error
              </div>
            </div>
            <div style={{ padding: 40, textAlign: "center", fontFamily: "Tahoma, sans-serif" }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>😵</div>
              <h2 style={{ margin: "0 0 8px", color: "#1a4ab8" }}>Something went wrong</h2>
              <p style={{ color: "#666", marginBottom: 20 }}>{this.state.error?.message || "An unexpected error occurred."}</p>
              <button
                className="win95-button primary"
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.reload();
                }}
              >
                Restart Streamana
              </button>
            </div>
          </div>
          <div className="taskbar">
            <button className="start-button">🪟 start</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {

  // Restore session from sessionStorage so page reload keeps you in the room
  const [username, setUsername] = useState(() => sessionStorage.getItem("streamana-username") || "");
  const [hasUsername, setHasUsername] = useState(() => Boolean(sessionStorage.getItem("streamana-username")));

  const [roomId, setRoomId] = useState("");
  const [joinedRoom, setJoinedRoom] = useState("");
  const [roomUsers, setRoomUsers] = useState([]);

  const [videoUrl, setVideoUrl] = useState("");

  const [activeVideo, setActiveVideo] = useState(
    "https://www.w3schools.com/html/mov_bbb.mp4"
  );

  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");

  // "idle" | "loading" | "ready" | "error"
  const [playerStatus, setPlayerStatus] = useState("idle");
  const [playerError, setPlayerError] = useState("");

  const [clock, setClock] = useState("");

  const videoRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const embedPlayerRef = useRef(null);
  const isRemoteAction = useRef(false);
  const pendingSyncState = useRef(null);
  const youtubeTimeTracker = useRef({ time: 0, checkedAt: 0 });
  const lastControlEmitAt = useRef(0);
  const lastRemoteSyncTarget = useRef(null);
  const messagesEndRef = useRef(null);
  const playerLoadTimer = useRef(null);

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

  const isValidHttpUrl = (url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  };

  const isEmbedVideo =
    isValidHttpUrl(activeVideo) &&
    (activeVideo.includes("/embed/") || activeVideo.includes("embed"));

  const getYoutubeVideoId = (url) => {
    if (!url) return null;
    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.replace(/^www\./, "");
      if (hostname !== "youtube.com" && hostname !== "youtu.be" && hostname !== "m.youtube.com") return null;
      let videoId = null;
      if (hostname === "youtu.be") videoId = parsedUrl.pathname.slice(1);
      else if (parsedUrl.searchParams.get("v")) videoId = parsedUrl.searchParams.get("v");
      else if (parsedUrl.pathname.includes("/embed/")) videoId = parsedUrl.pathname.split("/embed/")[1];
      else if (parsedUrl.pathname.includes("/shorts/")) videoId = parsedUrl.pathname.split("/shorts/")[1];
      // Strip any trailing path segments or slashes from the extracted ID
      if (videoId) videoId = videoId.split("/")[0].split("?")[0];
      return videoId || null;
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

    // Prevent feedback loops: ignore events that match a recent remote sync target (Issue #5)
    const target = lastRemoteSyncTarget.current;
    if (target && Date.now() - target.setAt < 3000) {
      const timeDiff = Math.abs(currentTime - target.currentTime);
      if (timeDiff < 2) {
        if (type === "play" && target.isPlaying) return;
        if (type === "pause" && !target.isPlaying) return;
        if (type === "seek") return;
      }
    }

    lastRemoteSyncTarget.current = null;
    socket.emit(type, { roomId: joinedRoom, currentTime });
  };

  const applySyncState = ({ currentTime, isPlaying }) => {
    suppressLocalEvents();
    lastRemoteSyncTarget.current = { currentTime, isPlaying, setAt: Date.now() };

    if (isEmbedVideo) {
      if (!embedPlayerRef.current || !embedPlayerRef.current.contentWindow) {
        pendingSyncState.current = { currentTime, isPlaying };
        return false;
      }
      try {
        embedPlayerRef.current.contentWindow.postMessage({ type: "PLAYER_SEEK", currentTime }, "*");
        embedPlayerRef.current.contentWindow.postMessage({ type: isPlaying ? "PLAYER_PLAY" : "PLAYER_PAUSE" }, "*");
      } catch {
        // Ignore iframe communication errors
      }
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
      if (syncState.videoUrl) {
        // Clear stale YouTube player ref before switching videos
        if (syncState.videoUrl !== activeVideo) {
          youtubePlayerRef.current = null;
          setPlayerStatus("loading");
          setPlayerError("");
        }
        setActiveVideo(syncState.videoUrl);
      }
      const latencySeconds = syncState.isPlaying && syncState.sentAt
        ? (Date.now() - syncState.sentAt) / 1000 : 0;
      pendingSyncState.current = {
        currentTime: (syncState.currentTime || 0) + latencySeconds,
        isPlaying: Boolean(syncState.isPlaying),
      };
      if (videoRef.current) videoRef.current.load();
      if (!syncState.videoUrl || syncState.videoUrl === activeVideo) {
        if (applySyncState(pendingSyncState.current)) pendingSyncState.current = null;
      }
    };

    const onJoinedRoom = (data) => {
      if (!data) return;
      setJoinedRoom(data.roomId);
      sessionStorage.setItem("streamana-room", data.roomId);
      setRoomUsers(data.users || []);
      queueSyncState(data.state);
    };

    const onSyncState = (data) => {
      if (!data) return;
      queueSyncState({ currentTime: data.currentTime, isPlaying: data.isPlaying, videoUrl: data.videoUrl });
    };

    const onRoomUsers = (users) => setRoomUsers(users || []);

    const onReceiveMessage = (data) => {
      if (!data) return;
      setMessages((prev) => [...prev, { username: data.username, message: data.message, timestamp: data.timestamp }]);
    };

    socket.on("joined-room", onJoinedRoom);
    socket.on("sync-state", onSyncState);
    socket.on("room-users", onRoomUsers);
    socket.on("receive-message", onReceiveMessage);

    return () => {
      socket.off("joined-room", onJoinedRoom);
      socket.off("sync-state", onSyncState);
      socket.off("room-users", onRoomUsers);
      socket.off("receive-message", onReceiveMessage);
    };
  }, [activeVideo, isEmbedVideo, isYoutubeVideo]);

  useEffect(() => {
    if (!pendingSyncState.current) return;
    if (applySyncState(pendingSyncState.current)) pendingSyncState.current = null;
  }, [activeVideo, isYoutubeVideo]);

  useEffect(() => {
    if (!joinedRoom || !isYoutubeVideo) return;
    youtubeTimeTracker.current = {
      time: youtubePlayerRef.current?.getCurrentTime() || 0,
      checkedAt: Date.now(),
    };
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
    const trimmed = username.trim();
    setUsername(trimmed);
    sessionStorage.setItem("streamana-username", trimmed);
    setHasUsername(true);
  };

  const joinRoom = () => {
    if (!roomId.trim() || !username.trim()) return;
    socket.emit("join-room", { roomId: roomId.trim(), username: username.trim() });
  };

  // Auto-rejoin room on page reload or socket reconnect
  useEffect(() => {
    const savedRoom = sessionStorage.getItem("streamana-room");
    const savedUsername = sessionStorage.getItem("streamana-username");
    if (savedRoom && savedUsername) {
      socket.emit("join-room", { roomId: savedRoom, username: savedUsername });
    }

    const handleReconnect = () => {
      const room = sessionStorage.getItem("streamana-room");
      const user = sessionStorage.getItem("streamana-username");
      if (room && user) {
        socket.emit("join-room", { roomId: room, username: user });
      }
    };
    socket.on("connect", handleReconnect);
    return () => socket.off("connect", handleReconnect);
  }, []);

  const loadVideo = () => {
    if (!videoUrl) return;
    if (!isValidHttpUrl(videoUrl)) {
      alert("Please enter a valid http:// or https:// URL.");
      return;
    }
    setPlayerStatus("loading");
    setPlayerError("");
    setActiveVideo(videoUrl);
    socket.emit("change-video", { roomId: joinedRoom, videoUrl });
  };

  const sendMessage = () => {
    if (!messageInput.trim() || !joinedRoom) return;
    socket.emit("send-message", { roomId: joinedRoom, message: messageInput.trim() });
    setMessageInput("");
  };

  const goBack = () => {
    if (joinedRoom) {
      socket.emit("leave-room", { roomId: joinedRoom });
    }
    sessionStorage.removeItem("streamana-room");
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
                  {/* Loading overlay */}
                  {playerStatus === "loading" && (
                    <div className="player-overlay">
                      <div className="player-overlay-icon">⏳</div>
                      <div className="player-overlay-text">Loading video...</div>
                    </div>
                  )}
                  {/* Error overlay */}
                  {playerStatus === "error" && (
                    <div className="player-overlay">
                      <div className="player-overlay-icon">⚠️</div>
                      <div className="player-overlay-text">{playerError || "This video could not be loaded."}</div>
                      <button className="win95-button" onClick={() => {
                        setPlayerStatus("loading");
                        setPlayerError("");
                        // Force remount by toggling active video
                        const url = activeVideo;
                        setActiveVideo("");
                        setTimeout(() => setActiveVideo(url), 100);
                      }}>Retry</button>
                    </div>
                  )}
                  {isEmbedVideo ? (
                    <iframe
                      ref={embedPlayerRef}
                      src={activeVideo}
                      className="embed-player"
                      frameBorder="0"
                      allowFullScreen
                      sandbox="allow-scripts allow-same-origin allow-presentation"
                      onLoad={() => {
                        setPlayerStatus("ready");
                        if (pendingSyncState.current && applySyncState(pendingSyncState.current)) {
                          pendingSyncState.current = null;
                        }
                      }}
                      onError={() => {
                        setPlayerStatus("error");
                        setPlayerError("Failed to load the embedded video.");
                      }}
                    />
                  ) : isYoutubeVideo ? (
                    <YouTube
                      key={getYoutubeVideoId(activeVideo)}
                      videoId={getYoutubeVideoId(activeVideo)}
                      className="youtube-player"
                      opts={{ width: "100%", height: "100%", playerVars: { autoplay: 0 } }}
                      onReady={(event) => {
                        youtubePlayerRef.current = event.target;
                        clearTimeout(playerLoadTimer.current);
                        setPlayerStatus("ready");
                        if (pendingSyncState.current && applySyncState(pendingSyncState.current)) {
                          pendingSyncState.current = null;
                        }
                        // Set a timeout: if the player hasn't started within 15s, warn the user
                        playerLoadTimer.current = setTimeout(() => {
                          const state = event.target.getPlayerState?.();
                          // -1 = unstarted, 0 = ended, 3 = buffering
                          if (state === -1 || state === 3) {
                            setPlayerStatus("error");
                            setPlayerError("Video is taking too long to load. It may be restricted or unavailable.");
                          }
                        }, 15000);
                      }}
                      onPlay={() => {
                        setPlayerStatus("ready");
                        clearTimeout(playerLoadTimer.current);
                        if (!isRemoteAction.current) emitPlaybackControl("play");
                      }}
                      onPause={() => { if (!isRemoteAction.current) emitPlaybackControl("pause"); }}
                      onError={(err) => {
                        clearTimeout(playerLoadTimer.current);
                        console.log("Youtube Player Error:", err);
                        const errorMessages = {
                          2: "Invalid video ID.",
                          5: "This video can't be played in an embedded player.",
                          100: "This video was not found or has been removed.",
                          101: "The video owner does not allow embedded playback.",
                          150: "The video owner does not allow embedded playback.",
                        };
                        setPlayerStatus("error");
                        setPlayerError(errorMessages[err?.data] || "This YouTube video could not be loaded.");
                      }}
                    />
                  ) : (
                    <video
                      ref={videoRef}
                      className="retro-video"
                      controls
                      onPlay={() => {
                        setPlayerStatus("ready");
                        if (!isRemoteAction.current) emitPlaybackControl("play");
                      }}
                      onPause={() => { if (!isRemoteAction.current) emitPlaybackControl("pause"); }}
                      onSeeked={() => {
                        if (!isRemoteAction.current) emitPlaybackControl("seek", videoRef.current.currentTime);
                      }}
                      onLoadedMetadata={() => {
                        setPlayerStatus("ready");
                        if (pendingSyncState.current && applySyncState(pendingSyncState.current)) {
                          pendingSyncState.current = null;
                        }
                      }}
                      onError={() => {
                        setPlayerStatus("error");
                        setPlayerError("Failed to load the video. The URL may be invalid or the format unsupported.");
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

function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

export default AppWithErrorBoundary;