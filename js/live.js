/* Auto Simulator — live sessions. One device starts a session and gets a short code; other
 * teams join with the code (or the invite link) from their own laptops. Devices connect
 * directly to each other (WebRTC via the free PeerJS service), so there are no accounts
 * and no server to run. The device that started the session relays every change to
 * everyone else. If it closes the page, the session ends (everyone keeps what they see). */
(function () {
  'use strict';
  const AC = (window.AC = window.AC || {});
  const $ = (s) => document.querySelector(s);
  const PREFIX = 'autosim-3647-';
  const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)

  let peer = null;
  let conns = [];
  let hosting = false;
  let code = '';
  const timers = {};

  const app = () => AC.app;

  function newCode() {
    let s = '';
    for (let k = 0; k < 4; k++) s += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    return s;
  }

  function setStatus(text, live) {
    $('#live-status').textContent = text;
    $('#live-bar').hidden = !live;
    $('#live-actions').hidden = !!live;
  }

  function renderBar() {
    const n = conns.filter((c) => c.open).length;
    const who = hosting ? `${n} other device${n === 1 ? '' : 's'} connected` : n ? 'Connected' : 'Reconnecting…';
    setStatus(`Live session ${code} · ${who}`, true);
  }

  function fullState() {
    const { state, robotData } = app();
    return { type: 'full', fieldId: state.fieldId, alliance: state.alliance, robots: state.robots.map(robotData) };
  }

  function wire(c) {
    conns.push(c);
    c.on('open', () => {
      if (hosting) c.send(fullState());
      renderBar();
    });
    c.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'full') app().applyRemote({ fieldId: msg.fieldId, alliance: msg.alliance, robots: msg.robots });
      else if (msg.type === 'robot') app().applyRemote({ i: msg.i, robot: msg.robot });
      else if (msg.type === 'field') app().applyRemote({ fieldId: msg.fieldId, alliance: msg.alliance });
      else return;
      // The host passes every change on to the other devices.
      if (hosting) for (const o of conns) if (o !== c && o.open) o.send(msg);
    });
    c.on('close', () => {
      conns = conns.filter((x) => x !== c);
      if (!hosting && peer) {
        app().toast('The session ended (the device that started it left)', true);
        leave();
      } else renderBar();
    });
  }

  function onPeerError(err) {
    if (err.type === 'unavailable-id' && hosting) {
      leave();
      start(); // code already taken, pick another
    } else if (err.type === 'peer-unavailable') {
      app().toast(`No session with code ${code}. Check the code and try again.`, true);
      leave();
    } else {
      app().toast(`Live session problem: ${err.message || err.type}`, true);
      leave();
    }
  }

  function start() {
    if (!window.Peer) return app().toast('Live sessions need an internet connection', true);
    hosting = true;
    code = newCode();
    setStatus('Starting…', false);
    peer = new window.Peer(PREFIX + code);
    peer.on('open', () => {
      renderBar();
      app().toast(`Session ${code} started. Share the code or invite link with the other teams.`);
    });
    peer.on('connection', wire);
    peer.on('error', onPeerError);
  }

  function join(raw) {
    if (!window.Peer) return app().toast('Live sessions need an internet connection', true);
    code = String(raw || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) return app().toast('Session codes are 4 letters or numbers', true);
    hosting = false;
    setStatus('Joining…', false);
    peer = new window.Peer();
    peer.on('open', () => wire(peer.connect(PREFIX + code, { reliable: true })));
    peer.on('error', onPeerError);
  }

  function leave() {
    if (peer) peer.destroy();
    peer = null;
    conns = [];
    hosting = false;
    setStatus('', false);
    if (location.search.includes('join=')) history.replaceState(null, '', location.pathname);
  }

  /** Called by the app after this device changes robot i (or the field when i = -1). */
  function send(i) {
    if (!peer || !conns.length) return;
    clearTimeout(timers[i]);
    timers[i] = setTimeout(() => {
      const { state, robotData } = app();
      const msg = i < 0 ? { type: 'field', fieldId: state.fieldId, alliance: state.alliance } : { type: 'robot', i, robot: robotData(state.robots[i]) };
      for (const c of conns) if (c.open) c.send(msg);
    }, 250);
  }

  function inviteLink() {
    return `${location.origin}${location.pathname}?join=${code}`;
  }

  function init() {
    $('#btn-live-start').addEventListener('click', start);
    $('#btn-live-join').addEventListener('click', () => {
      $('#join-code').value = '';
      $('#dlg-join').showModal();
    });
    $('#join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      $('#dlg-join').close();
      join($('#join-code').value);
    });
    $('#join-cancel').addEventListener('click', () => $('#dlg-join').close());
    $('#btn-live-leave').addEventListener('click', leave);
    $('#btn-live-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(inviteLink());
        app().toast('Invite link copied');
      } catch (e) {
        app().toast(`Invite link: ${inviteLink()}`);
      }
    });
    const fromLink = new URLSearchParams(location.search).get('join');
    if (fromLink) join(fromLink);
  }

  AC.live = { init, send, start, join, leave };
})();
