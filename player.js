'use strict';

// Trang này được host trên HTTPS (ví dụ GitHub Pages), không phải chrome-extension://.
// YouTube yêu cầu HTTP Referer hoặc định danh API client cho trình phát nhúng.
const params = new URLSearchParams(window.location.search);
const videoId = params.get('videoId') || '';
const channel = params.get('channel') || '';
const titleElement = document.getElementById('videoTitle');
const statusElement = document.getElementById('status');
let player = null;

function sendToParent(type, payload = {}) {
  if (window.parent === window) return;
  window.parent.postMessage({
    source: 'browser-music-player-youtube-bridge',
    channel,
    type,
    ...payload
  }, '*');
}

function isValidVideoId(value) {
  return /^[a-zA-Z0-9_-]{11}$/.test(value);
}

function setStatus(text) {
  statusElement.textContent = text;
}

window.onYouTubeIframeAPIReady = function () {
  if (!isValidVideoId(videoId)) {
    titleElement.textContent = 'Link YouTube không hợp lệ';
    setStatus('Không tìm thấy mã video YouTube hợp lệ trong đường dẫn.');
    sendToParent('ERROR', { errorCode: 'INVALID_VIDEO_ID' });
    return;
  }

  player = new YT.Player('player', {
    width: '100%',
    height: '100%',
    videoId,
    playerVars: {
      autoplay: 0,
      controls: 1,
      enablejsapi: 1,
      playsinline: 1,
      rel: 0,
      origin: window.location.origin
    },
    events: {
      onReady(event) {
        const data = event.target.getVideoData ? event.target.getVideoData() : {};
        const title = data.title || 'YouTube video';
        titleElement.textContent = title;
        setStatus('Trình phát đã sẵn sàng. Nhấn Play trên video để bắt đầu.');
        sendToParent('READY', { title, videoId });
      },
      onStateChange(event) {
        const data = player && player.getVideoData ? player.getVideoData() : {};
        const title = data.title || titleElement.textContent;
        if (title) titleElement.textContent = title;
        sendToParent('STATE', { playerState: event.data, title });
      },
      onError(event) {
        setStatus(`YouTube trả về lỗi ${event.data}. Video có thể không cho phép nhúng hoặc không khả dụng.`);
        sendToParent('ERROR', { errorCode: event.data });
      }
    }
  });
};

// Chỉ nhận lệnh từ cửa sổ cha đang nhúng trang này; channel phải khớp tham số phiên.
window.addEventListener('message', event => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.source !== 'browser-music-player-extension' || message.channel !== channel) return;
  if (!player || typeof player[message.func] !== 'function') return;

  const allowed = new Set([
    'playVideo', 'pauseVideo', 'stopVideo', 'mute', 'unMute',
    'setVolume', 'seekTo', 'loadVideoById', 'cueVideoById'
  ]);
  if (!allowed.has(message.func)) return;

  try {
    player[message.func](...(Array.isArray(message.args) ? message.args : []));
  } catch (error) {
    sendToParent('COMMAND_ERROR', { message: String(error?.message || error) });
  }
});
