/* Live chat overlay ("danmaku"), adapted from uKick. Public Kick chat arrives over Pusher; CSS transitions
   replace Web Animations, which Chromium 38 on webOS 3 lacks. Messages are built from text nodes, never markup. */
function KickDanmaku(host, options) {
  'use strict';
  var config = { crossing: 9000, fontSize: 40, laneArea: 0.62, gap: 48, baseInterval: 120, normalInterval: 50, fastInterval: 25,
    maxQueue: 60, maxOnScreen: 45, maxText: 100, maxEmotes: 8 };
  var colors = ['#ffffff', '#ffebee', '#e3f2fd', '#e8f5e9', '#fff3e0', '#f3e5f5'];
  var socket = null, room = 0, endpoint = '', epoch = 0, queue = [], lanes = [], onScreen = 0;
  var displayTimer = null, retryTimer = null, retries = 0;
  options = options || {};

  function now() { return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(); }
  function appendText(node, text) {
    if (!text) return;
    if (options.text) options.text(node, text);
    else { var span = document.createElement('span'); span.textContent = text; node.appendChild(span); }
  }
  // Kick encodes emotes inline as [emote:id:name]; links are dropped like uKick does.
  function parse(content) {
    if (typeof content !== 'string' || !content || content.length > 2000) return null;
    var parts = [], text = '', emotes = 0, pattern = /\[emote:(\d{1,12}):([^\]\s]{0,64})\]/g, index = 0, match;
    function words(value) {
      value = value.replace(/https?:\/\/[^\s]+/gi, '').replace(/\s+/g, ' ');
      if (value) { parts.push({ text: value }); text += value; }
    }
    while ((match = pattern.exec(content)) !== null) {
      words(content.slice(index, match.index));
      if (emotes < config.maxEmotes) { parts.push({ emote: match[1], name: match[2] }); emotes++; }
      index = match.index + match[0].length;
    }
    words(content.slice(index));
    text = text.trim();
    if (text.length > config.maxText || !text && !emotes) return null;
    return { parts: parts, emotes: emotes };
  }
  function enqueue(message) {
    if (queue.length >= config.maxQueue) queue.shift();
    queue.push(message);
  }
  function laneHeight() { return Math.round(config.fontSize * 1.45); }
  function pickLane(count, at) {
    for (var i = 0; i < count; i++) if (!lanes[i] || lanes[i] <= at) return i;
    return -1;
  }
  function show(message) {
    var width = host.clientWidth, height = host.clientHeight;
    if (!width || !height || onScreen >= config.maxOnScreen) return false;
    var count = Math.max(1, Math.floor(height * config.laneArea / laneHeight())), at = now(), lane = pickLane(count, at);
    if (lane < 0) return false;
    var item = document.createElement('div');
    item.className = 'danmaku-item';
    if (!message.emotes) item.style.color = colors[Math.floor(Math.random() * colors.length)];
    message.parts.forEach(function (part) {
      if (part.text) { appendText(item, part.text); return; }
      var img = document.createElement('img');
      img.alt = part.name; img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () {
        if (img.parentNode !== item) return;
        var label = document.createElement('span'); label.textContent = part.name; item.replaceChild(label, img);
      });
      img.src = 'https://files.kick.com/emotes/' + part.emote + '/fullsize';
      item.appendChild(img);
    });
    item.style.top = Math.round(height * 0.04) + lane * laneHeight() + 'px';
    item.style.left = width + 'px';
    host.appendChild(item); onScreen++;
    // A fixed pixel speed keeps a later, longer message from catching the one ahead in its lane.
    var speed = width / config.crossing, itemWidth = Math.max(item.offsetWidth, 40);
    var distance = width + itemWidth, duration = Math.round(distance / speed);
    lanes[lane] = at + (itemWidth + config.gap) / speed;
    var token = epoch, motion = 'translateX(-' + distance + 'px)';
    item.style.webkitTransition = item.style.transition = 'transform ' + duration + 'ms linear, -webkit-transform ' + duration + 'ms linear';
    void item.offsetWidth;
    item.style.webkitTransform = item.style.transform = motion;
    setTimeout(function () {
      if (item.parentNode === host) host.removeChild(item);
      if (token === epoch) onScreen--;
    }, duration + 100);
    return true;
  }
  function pump() {
    displayTimer = null;
    if (!room) return;
    var delay = config.baseInterval;
    if (queue.length && show(queue[0])) {
      queue.shift();
      if (queue.length > 15) delay = config.fastInterval;
      else if (queue.length > 5) delay = config.normalInterval;
    }
    displayTimer = setTimeout(pump, delay);
  }
  function send(data) { try { socket.send(JSON.stringify(data)); } catch (e) { /* A closing socket reconnects below. */ } }
  function receive(raw) {
    var frame, payload;
    try {
      if (typeof raw !== 'string' || raw.length > 65536) return;
      frame = JSON.parse(raw);
    } catch (e) { return; }
    if (!frame || typeof frame.event !== 'string') return;
    if (frame.event === 'pusher:connection_established') {
      retries = 0;
      send({ event: 'pusher:subscribe', data: { auth: '', channel: 'chatrooms.' + room + '.v2' } });
    } else if (frame.event === 'pusher:ping') send({ event: 'pusher:pong', data: {} });
    else if (frame.event === 'App\\Events\\ChatMessageEvent' && frame.channel === 'chatrooms.' + room + '.v2') {
      try { payload = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data; } catch (e) { return; }
      if (!payload || payload.type !== 'message' && payload.type !== 'reply') return;
      var message = parse(payload.content);
      if (message) enqueue(message);
    }
  }
  function connect() {
    retryTimer = null;
    if (!room || typeof WebSocket === 'undefined') return;
    if (navigator.onLine === false) { reconnect(); return; }
    var token = epoch, ws;
    try { ws = new WebSocket(endpoint); } catch (e) { reconnect(); return; }
    socket = ws;
    ws.onmessage = function (event) { if (token === epoch) receive(event.data); };
    ws.onclose = ws.onerror = function () {
      if (token !== epoch || socket !== ws) return;
      socket = null; reconnect();
    };
  }
  function reconnect() {
    if (!room || retryTimer) return;
    retryTimer = setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, retries++)));
  }
  function stop() {
    epoch++; room = 0; endpoint = ''; queue = []; lanes = []; onScreen = 0; retries = 0;
    clearTimeout(displayTimer); clearTimeout(retryTimer); displayTimer = retryTimer = null;
    var previous = socket; socket = null;
    if (previous) {
      previous.onmessage = previous.onclose = previous.onerror = null;
      try { previous.close(); } catch (e) { /* Already closed. */ }
    }
    while (host.firstChild) host.removeChild(host.firstChild);
  }
  // Credentials come from the TV service: { key, cluster } for Kick's public Pusher app.
  function start(chatroom, realtime) {
    var key = realtime && realtime.key, cluster = realtime && realtime.cluster;
    if (typeof chatroom !== 'number' || chatroom <= 0 || chatroom % 1 !== 0 ||
      typeof key !== 'string' || !/^[a-f0-9]{8,64}$/.test(key) || typeof cluster !== 'string' || !/^[a-z0-9]{2,8}$/.test(cluster)) { stop(); return; }
    var next = 'wss://ws-' + cluster + '.pusher.com/app/' + key + '?protocol=7&client=js&version=8.4.0&flash=false';
    if (chatroom === room && next === endpoint) return;
    stop(); room = chatroom; endpoint = next;
    connect(); pump();
  }
  return { start: start, stop: stop, active: function () { return room; } };
}
if (typeof module !== 'undefined') module.exports = KickDanmaku;
