'use strict';

// The hosted page accepts commands only from the exact extension origin passed
// by the extension itself. Chrome may expose MessageEvent.source as null for
// postMessage calls initiated by extension code, so do not require source===window.
const params = new URLSearchParams(window.location.search);
const initialVideoId = params.get('videoId') || '';
const channel = params.get('channel') || '';
const extensionId = params.get('extensionId') || '';
const expectedExtensionOrigin = /^[a-p]{32}$/.test(extensionId)
  ? `chrome-extension://${extensionId}`
  : '';
const initialVolume = Math.round(Math.max(0, Math.min(1, Number(params.get('volume') ?? '0.8'))) * 100);
const titleElement = document.getElementById('videoTitle');
const statusElement = document.getElementById('status');
const youtubeLink = document.getElementById('youtubeLink');

let player = null;
let currentVideoId = initialVideoId;
let pendingCommands = [];

function isValidVideoId(value) {
  return /^[a-zA-Z0-9_-]{11}$/.test(value || '');
}

function setStatus(text) {
  statusElement.textContent = text;
}

function getVideoDetails() {
  let data = {};
  try { data = player?.getVideoData?.() || {}; } catch (_) {}
  return { videoId: data.video_id || currentVideoId, title: data.title || '' };
}

function emitBridgeEvent(type, payload = {}) {
  if (!channel) return;
  window.postMessage({ source: 'browser-music-player-youtube-bridge', channel, type, ...payload }, window.location.origin);
}

const allowedCommands = new Set([
  'playVideo', 'pauseVideo', 'stopVideo', 'mute', 'unMute',
  'setVolume', 'seekTo', 'loadVideoById', 'cueVideoById'
]);

function runPlayerCommand(command) {
  if (!player || !command || !allowedCommands.has(command.func)) return false;
  const args = Array.isArray(command.args) ? command.args : [];
  try {
    if (command.func === 'setVolume') {
      const volume = Math.max(0, Math.min(100, Number(args[0])));
      player.setVolume(Number.isFinite(volume) ? volume : 80);
      return true;
    }
    if (command.func === 'loadVideoById' || command.func === 'cueVideoById') {
      const input = args[0];
      const videoId = typeof input === 'string' ? input : input?.videoId;
      if (!isValidVideoId(videoId)) return false;
      currentVideoId = videoId;
      titleElement.textContent = 'Đang tải video...';
      youtubeLink.href = `https://www.youtube.com/watch?v=${videoId}`;
      const options = typeof input === 'string'
        ? { videoId, startSeconds: 0 }
        : { videoId, startSeconds: Math.max(0, Number(input.startSeconds) || 0) };
      player[command.func](options);
      return true;
    }
    player[command.func](...args);
    return true;
  } catch (error) {
    emitBridgeEvent('COMMAND_ERROR', { message: String(error?.message || error), videoId: currentVideoId });
    return false;
  }
}

function acknowledgeCommand(command, accepted, queued = false) {
  emitBridgeEvent('COMMAND_ACK', {
    command: String(command || '').slice(0, 40),
    accepted: Boolean(accepted),
    queued: Boolean(queued),
    videoId: currentVideoId
  });
}

window.addEventListener('message', event => {
  // For messages posted by extension code, Chrome may set source to null.
  // Authenticate by exact extension origin plus the random per-tab channel.
  if (!expectedExtensionOrigin || event.origin !== expectedExtensionOrigin) return;
  if (event.source !== null && event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== 'browser-music-player-extension' || message.channel !== channel) return;
  if (!allowedCommands.has(message.func)) return;
  console.info('[Browser Music Player Bridge] Nhận lệnh từ extension:', message.func);

  if (!player) {
    pendingCommands.push({ func: message.func, args: Array.isArray(message.args) ? message.args : [] });
    acknowledgeCommand(message.func, true, true);
    return;
  }
  const accepted = runPlayerCommand(message);
  acknowledgeCommand(message.func, accepted, false);
  if (!accepted) emitBridgeEvent('COMMAND_ERROR', { message: `Bridge không thực hiện được lệnh ${message.func}.`, videoId: currentVideoId });
});

if (!expectedExtensionOrigin || !channel) {
  setStatus('Tab này chưa được mở bởi Browser Music Player. Hãy mở video từ popup extension để bật kết nối điều khiển.');
} else {
  emitBridgeEvent('SCRIPT_READY');
}

window.onYouTubeIframeAPIReady = function () {
  if (!isValidVideoId(initialVideoId)) {
    titleElement.textContent = 'Link YouTube không hợp lệ';
    setStatus('Không tìm thấy mã video YouTube hợp lệ trong đường dẫn.');
    emitBridgeEvent('ERROR', { errorCode: 2, videoId: initialVideoId });
    return;
  }
  if (!expectedExtensionOrigin || !channel) {
    setStatus('Hãy mở video thông qua popup Browser Music Player để bật điều khiển từ extension.');
  }
  youtubeLink.href = `https://www.youtube.com/watch?v=${initialVideoId}`;
  player = new YT.Player('player', {
    width: '100%', height: '100%', videoId: initialVideoId,
    playerVars: {
      autoplay: 0, controls: 1, enablejsapi: 1, playsinline: 1, rel: 0,
      origin: window.location.origin
    },
    events: {
      onReady(event) {
        event.target.setVolume(Number.isFinite(initialVolume) ? initialVolume : 80);
        const details = getVideoDetails();
        if (details.title) titleElement.textContent = details.title;
        setStatus('Trình phát đã sẵn sàng. Nhấn Play trên video để bắt đầu; sau đó có thể dùng nút điều khiển trong popup.');
        emitBridgeEvent('READY', details);
        const queued = pendingCommands.splice(0);
        queued.forEach(command => {
          const accepted = runPlayerCommand(command);
          acknowledgeCommand(command.func, accepted, false);
        });
      },
      onStateChange(event) {
        const details = getVideoDetails();
        if (details.title) titleElement.textContent = details.title;
        const labels = { '-1': 'Chưa bắt đầu', '0': 'Đã phát hết video', '1': 'Đang phát', '2': 'Đã tạm dừng', '3': 'Đang tải/buffering', '5': 'Đã sẵn sàng' };
        setStatus(labels[String(event.data)] || 'Trạng thái trình phát đã thay đổi.');
        emitBridgeEvent('STATE', { ...details, playerState: event.data });
      },
      onError(event) {
        setStatus(`YouTube trả về lỗi ${event.data}. Video có thể không cho phép nhúng hoặc không khả dụng.`);
        emitBridgeEvent('ERROR', { videoId: currentVideoId, errorCode: event.data });
      },
      onAutoplayBlocked() {
        setStatus('YouTube đã chặn lệnh Play từ xa. Hãy nhấn Play trực tiếp trên video một lần. Các lệnh Pause/Volume vẫn có thể được gửi từ popup.');
        emitBridgeEvent('AUTOPLAY_BLOCKED', { videoId: currentVideoId });
      }
    }
  });
};
