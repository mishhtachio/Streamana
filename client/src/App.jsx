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

  const videoRef = useRef(null);

  const youtubePlayerRef = useRef(null);

  const embedPlayerRef = useRef(null);

  const isRemoteAction = useRef(false);

  const pendingSyncState = useRef(null);
  const youtubeTimeTracker = useRef({
    time: 0,
    checkedAt: Date.now(),
  });
  const lastControlEmitAt = useRef(0);

  const isEmbedVideo =
    activeVideo.includes("/embed/") ||
    activeVideo.includes("embed");

  const getYoutubeVideoId = (url) => {
    if (!url) return null;

    try {

      const parsedUrl = new URL(url);

      // youtu.be short links
      if (
        parsedUrl.hostname === "youtu.be"
      ) {
        return parsedUrl.pathname.slice(1);
      }

      // youtube.com/watch?v=
      if (
        parsedUrl.searchParams.get("v")
      ) {
        return parsedUrl.searchParams.get("v");
      }

      // youtube.com/embed/
      if (
        parsedUrl.pathname.includes("/embed/")
      ) {
        return parsedUrl.pathname.split("/embed/")[1];
      }

      // youtube shorts
      if (
        parsedUrl.pathname.includes("/shorts/")
      ) {
        return parsedUrl.pathname.split("/shorts/")[1];
      }

      return null;

    } catch {

      return null;

    }

  };

  const isYoutubeVideo =
    getYoutubeVideoId(activeVideo) !== null;

  const suppressLocalEvents = () => {

    isRemoteAction.current = true;

    window.clearTimeout(
      suppressLocalEvents.timeoutId
    );

    suppressLocalEvents.timeoutId =
      window.setTimeout(() => {
        isRemoteAction.current = false;
      }, 700);

  };

  const canEmitControl = () => {

    const now = Date.now();

    if (now - lastControlEmitAt.current < 250) {
      return false;
    }

    lastControlEmitAt.current = now;
    return true;

  };

  const getCurrentTime = () => {

    if (isYoutubeVideo && youtubePlayerRef.current) {
      return youtubePlayerRef.current.getCurrentTime();
    }

    if (videoRef.current) {
      return videoRef.current.currentTime;
    }

    return 0;

  };

  const emitPlaybackControl = (
    type,
    currentTime = getCurrentTime()
  ) => {

    if (!joinedRoom || isRemoteAction.current) return;
    if (!canEmitControl()) return;

    socket.emit(type, {
      roomId: joinedRoom,
      currentTime,
    });

  };

  const applySyncState = ({
    currentTime,
    isPlaying,
  }) => {

    suppressLocalEvents();

    if (isEmbedVideo) {
      // If embed iframe isn't ready yet, keep pending state
      if (!embedPlayerRef.current || !embedPlayerRef.current.contentWindow) {
        pendingSyncState.current = { currentTime, isPlaying };
        return false;
      }

      // Send postMessage commands to the embed player
      try {
        embedPlayerRef.current.contentWindow.postMessage(
          { type: "PLAYER_SEEK", currentTime },
          "*"
        );

        embedPlayerRef.current.contentWindow.postMessage(
          { type: isPlaying ? "PLAYER_PLAY" : "PLAYER_PAUSE" },
          "*"
        );
      } catch (e) {
        // ignore postMessage failures
      }

      pendingSyncState.current = null;
      return true;
    }

    if (isYoutubeVideo) {

      if (!youtubePlayerRef.current) return false;

      youtubePlayerRef.current.seekTo(
        currentTime,
        true
      );

      youtubeTimeTracker.current = {
        time: currentTime,
        checkedAt: Date.now(),
      };

      if (isPlaying) {
        youtubePlayerRef.current.playVideo();
      } else {
        youtubePlayerRef.current.pauseVideo();
      }

      return true;

    }

    if (!videoRef.current) return false;
    if (videoRef.current.readyState < 1) return false;

    videoRef.current.currentTime = currentTime;

    if (isPlaying) {
      videoRef.current.play().catch(() => {});
    } else {
      videoRef.current.pause();
    }

    return true;

  };

  useEffect(() => {

    const queueSyncState = (syncState) => {

      if (!syncState) return;

      setActiveVideo(syncState.videoUrl);

      const latencySeconds =
        syncState.isPlaying && syncState.sentAt
          ? (Date.now() - syncState.sentAt) / 1000
          : 0;

      pendingSyncState.current = {
        currentTime:
          (syncState.currentTime || 0) + latencySeconds,
        isPlaying: Boolean(syncState.isPlaying),
      };

      if (videoRef.current) {
        videoRef.current.load();
      }

      if (syncState.videoUrl === activeVideo) {
        if (applySyncState(pendingSyncState.current)) {
          pendingSyncState.current = null;
        }
      }

    };

    socket.on("joined-room", ({
      roomId,
      users,
      state,
    }) => {

      setJoinedRoom(roomId);
      setRoomUsers(users || []);
      queueSyncState(state);

    });

    socket.on("sync-state", ({
      currentTime,
      isPlaying,
      videoUrl,
    }) => {

      queueSyncState({
        currentTime,
        isPlaying,
        videoUrl,
      });

    });

    socket.on("room-users", (users) => {
      setRoomUsers(users);
    });

    socket.on("receive-message", ({
      username,
      message,
      timestamp,
    }) => {
      setMessages((prev) => [...prev, {
        username,
        message,
        timestamp,
      }]);
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

    if (applySyncState(pendingSyncState.current)) {
      pendingSyncState.current = null;
    }

  }, [activeVideo, isYoutubeVideo]);

  useEffect(() => {

    if (!joinedRoom || !isYoutubeVideo) return;

    const intervalId = window.setInterval(() => {

      if (
        !youtubePlayerRef.current ||
        isRemoteAction.current
      ) {
        return;
      }

      const currentTime =
        youtubePlayerRef.current.getCurrentTime();

      const playerState =
        youtubePlayerRef.current.getPlayerState?.();

      const isPlaying = playerState === 1;
      const now = Date.now();
      const previous = youtubeTimeTracker.current;
      const elapsed = (now - previous.checkedAt) / 1000;
      const expectedDelta = isPlaying ? elapsed : 0;
      const actualDelta = currentTime - previous.time;

      if (
        Math.abs(actualDelta - expectedDelta) > 1.75
      ) {
        emitPlaybackControl("seek", currentTime);
      }

      youtubeTimeTracker.current = {
        time: currentTime,
        checkedAt: now,
      };

    }, 700);

    return () => {
      window.clearInterval(intervalId);
    };

  }, [joinedRoom, isYoutubeVideo]);

  const playMedia = () => {

    if (isYoutubeVideo && youtubePlayerRef.current) {
      youtubePlayerRef.current.playVideo();
    } else if (videoRef.current) {
      videoRef.current.play().catch(() => {});
    }

    emitPlaybackControl("play");

  };

  const pauseMedia = () => {

    if (isYoutubeVideo && youtubePlayerRef.current) {
      youtubePlayerRef.current.pauseVideo();
    } else if (videoRef.current) {
      videoRef.current.pause();
    }

    emitPlaybackControl("pause");

  };

  const seekMediaBy = (seconds) => {

    const nextTime = Math.max(
      0,
      getCurrentTime() + seconds
    );

    if (isYoutubeVideo && youtubePlayerRef.current) {
      youtubePlayerRef.current.seekTo(
        nextTime,
        true
      );
    } else if (videoRef.current) {
      videoRef.current.currentTime = nextTime;
    }

    emitPlaybackControl("seek", nextTime);

  };

  const continueToRoom = () => {

    if (!username.trim()) return;

    setUsername(username.trim());
    setHasUsername(true);

  };

  const joinRoom = () => {

    if (!roomId.trim() || !username.trim()) return;

    const nextRoomId = roomId.trim();

    socket.emit("join-room", {
      roomId: nextRoomId,
      username: username.trim(),
    });

  };

  const loadVideo = () => {

    if (!videoUrl) return;

    setActiveVideo(videoUrl);

    socket.emit("change-video", {
      roomId: joinedRoom,
      videoUrl,
    });

  };

  const sendMessage = () => {

    if (!messageInput.trim() || !joinedRoom) return;

    socket.emit("send-message", {
      roomId: joinedRoom,
      message: messageInput.trim(),
    });

    setMessageInput("");

  };

  return (
    <div className="desktop">

      {/* ICONS */}

      <div className="desktop-icon">
        🎵
        <span>Music</span>
      </div>

      <div className="desktop-icon second">
        📼
        <span>Movies</span>
      </div>

      {/* MAIN WINDOW */}

      <div className="window">

        {/* TITLE BAR */}

        <div className="title-bar">

          <div className="title-left">
            💿 Streamana.exe
          </div>

          <div className="window-buttons">
            <button>—</button>
            <button>□</button>
            <button>✕</button>
          </div>

        </div>

        {/* MENU */}

        <div className="menu-bar">
          File Edit View Favorites Help
        </div>

        {/* CONTENT */}

        <div className="window-content">

          {!joinedRoom ? (

            <div className="join-screen">

              <div className="big-logo">
                STREAMANA 95
              </div>

              <div className="join-panel">

                {!hasUsername ? (

                  <>

                    <div className="field-label">
                      Username:
                    </div>

                    <input
                      type="text"
                      value={username}
                      onChange={(e) =>
                        setUsername(e.target.value)
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          continueToRoom();
                        }
                      }}
                      className="win95-input"
                    />

                    <button
                      className="win95-button"
                      onClick={continueToRoom}
                    >
                      Continue
                    </button>

                  </>

                ) : (

                  <>

                    <div className="field-label">
                      Room Name:
                    </div>

                    <input
                      type="text"
                      value={roomId}
                      onChange={(e) =>
                        setRoomId(e.target.value)
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          joinRoom();
                        }
                      }}
                      className="win95-input"
                    />

                    <button
                      className="win95-button"
                      onClick={joinRoom}
                    >
                      Connect
                    </button>

                  </>

                )}

              </div>

            </div>

          ) : (

            <div className="player-layout">

              {/* LEFT PANEL */}

              <div className="sidebar">

                <div className="mini-window">

                  <div className="mini-title">
                    Current Room
                  </div>

                  <div className="mini-body">
                    {joinedRoom}
                  </div>

                </div>

                <div className="mini-window">

                  <div className="mini-title">
                    In Room
                  </div>

                  <div className="mini-body users-list">

                    {roomUsers.map((user) => (
                      <div
                        className="user-row"
                        key={user.id}
                      >
                        {user.username}
                      </div>
                    ))}

                  </div>

                </div>

                <div className="mini-window">

                  <div className="mini-title">
                    Load Media
                  </div>

                  <div className="mini-body">

                    <input
                      type="text"
                      placeholder="Paste URL"
                      value={videoUrl}
                      onChange={(e) =>
                        setVideoUrl(e.target.value)
                      }
                      className="win95-input"
                    />

                    <button
                      className="win95-button"
                      onClick={loadVideo}
                    >
                      Load
                    </button>

                  </div>

                </div>

                <div className="mini-window">

                  <div className="mini-title">
                    Chat
                  </div>

                  <div className="mini-body chat-window">

                    <div className="messages-container">
                      {messages.map((msg, idx) => (
                        <div key={idx} className="chat-message">
                          <span className="chat-username">
                            {msg.username}:
                          </span>
                          <span className="chat-text">
                            {msg.message}
                          </span>
                        </div>
                      ))}
                    </div>

                    <input
                      type="text"
                      placeholder="Type message..."
                      value={messageInput}
                      onChange={(e) =>
                        setMessageInput(e.target.value)
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          sendMessage();
                        }
                      }}
                      className="win95-input chat-input"
                    />

                    <button
                      className="send-button"
                      onClick={sendMessage}
                    >
                      Send
                    </button>

                  </div>

                </div>

              </div>



              {/* PLAYER */}

              <div className="media-window">

                <div className="media-header">
                  Now Playing
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
                        // Apply pending sync state when iframe loads
                        if (
                          pendingSyncState.current &&
                          applySyncState(pendingSyncState.current)
                        ) {
                          pendingSyncState.current = null;
                        }
                      }}
                    />

                  ) : isYoutubeVideo ? (

                    <YouTube
                      videoId={
                        getYoutubeVideoId(activeVideo)
                      }

                      className="youtube-player"

                      opts={{
                        width: "100%",
                        height: "100%",
                        playerVars: {
                          autoplay: 0,
                        },
                      }}

                      onReady={(event) => {
                        youtubePlayerRef.current =
                          event.target;

                        if (
                          pendingSyncState.current &&
                          applySyncState(pendingSyncState.current)
                        ) {
                          pendingSyncState.current =
                            null;
                        }
                      }}

                      onPlay={() => {

                        if (
                          isRemoteAction.current
                        ) {
                          return;
                        }

                        emitPlaybackControl("play");

                      }}

                      onPause={() => {

                        if (
                          isRemoteAction.current
                        ) {
                          return;
                        }

                        emitPlaybackControl("pause");

                      }}

                      onError={(err) => {
                        console.log(
                          "Youtube Player Error:",
                          err
                        );

                        alert(
                          "This YouTube video cannot be embedded."
                        );
                      }}

                    />

                  ) : (

                    <video
                      ref={videoRef}
                      className="retro-video"
                      controls

                      onPlay={() => {

                        if (
                          isRemoteAction.current
                        ) {
                          return;
                        }

                        emitPlaybackControl("play");

                      }}

                      onPause={() => {

                        if (
                          isRemoteAction.current
                        ) {
                          return;
                        }

                        emitPlaybackControl("pause");

                      }}

                      onSeeked={() => {

                        if (
                          isRemoteAction.current
                        ) {
                          return;
                        }

                        emitPlaybackControl(
                          "seek",
                          videoRef.current.currentTime
                        );

                      }}

                      onLoadedMetadata={() => {

                        if (
                          pendingSyncState.current &&
                          applySyncState(pendingSyncState.current)
                        ) {
                          pendingSyncState.current =
                            null;
                        }

                      }}

                    >
                      <source
                        src={activeVideo}
                        type="video/mp4"
                      />
                    </video>

                  )}

                </div>

                <div className="status-bar">
                  {username} connected to room :: {joinedRoom}
                </div>

              </div>

            </div>

          )}

        </div>

      </div>

      {/* TASKBAR */}

      <div className="taskbar">

        <button className="start-button">
          🪟 Start
        </button>

        <div className="taskbar-app">
          Streamana
        </div>

        <div className="clock">
          9:41 PM
        </div>

      </div>

    </div>
  );
} // safe safe

export default App;
