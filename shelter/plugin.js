(() => {
  // ===================== Settings =====================
  // Persistent plugin store (shelter.plugin.store); falls back to a plain object if unavailable.
  const store = (shelter.plugin && shelter.plugin.store) || {};
  const DEFAULTS = {
    rewriteContext: true,   // playlist -> album context rewrite (main fix, skips /v1/playlists)
    fakePlaylist: true,     // 403/404 fallback for /v1/playlists, /albums, /tracks, ...
    fakeProfile: true,      // 403/404 fallback for /v1/me
    premium: true,          // product returned by the fake /v1/me (needed for Listen Along)
    country: "",            // optional country for the fake /v1/me, e.g. "TR"
    polling: true,          // poll /v1/me/player ourselves and feed SPOTIFY_PLAYER_STATE
    pollInterval: 4,        // seconds
    debug: false,           // verbose logging
  };
  for (const k in DEFAULTS) if (store[k] === undefined) store[k] = DEFAULTS[k];

  const TAG = "[SpotifyRPCFix]";
  const API_RE = /^https:\/\/api\.spotify\.com\/v1\//;
  const RES_RE = /\/v1\/(playlists|albums|artists|tracks|episodes|shows)\/([A-Za-z0-9]+)\/?$/;
  const ME_RE = /\/v1\/me\/?$/;
  const PLAYER_RE = /\/v1\/me\/player(\/currently-playing)?\/?$/;

  let lastPlayer = null;
  const log = (...a) => console.log("%c" + TAG, "color:#1db954;font-weight:bold", ...a);
  const dbg = (...a) => { if (store.debug) log(...a); };
  const pathOf = (url) => { try { return new URL(url, location.href).pathname; } catch (e) { return String(url); } };

  // Status line shown in the settings panel
  const [status, setStatus] = shelter.solid.createSignal("No player state received yet");

  // ===================== Fake responses =====================
  const user = (id, name) => ({
    id, type: "user", uri: "spotify:user:" + id, display_name: name || id,
    href: "https://api.spotify.com/v1/users/" + id,
    external_urls: { spotify: "https://open.spotify.com/user/" + id },
    followers: { href: null, total: 0 }, images: [],
  });

  function spotifyAccount(auth) {
    try {
      const token = (auth || "").replace(/^Bearer\s+/i, "");
      const accs = shelter.flux.stores.ConnectedAccountsStore.getAccounts().filter((a) => a.type === "spotify");
      return accs.find((a) => a.accessToken === token || a.access_token === token) || accs[0] || null;
    } catch (e) { return null; }
  }

  function fakeMe(auth) {
    const acc = spotifyAccount(auth);
    if (!acc) return null;
    const me = Object.assign(user(acc.id, acc.name), {
      product: store.premium ? "premium" : "free",
      explicit_content: { filter_enabled: false, filter_locked: false },
    });
    if (store.country) me.country = store.country.toUpperCase();
    return me;
  }

  function fakePlaylist(id) {
    const uri = "spotify:playlist:" + id;
    const ctx = lastPlayer && lastPlayer.context;
    const list = { href: "https://api.spotify.com/v1/playlists/" + id + "/tracks", total: 0, limit: 0, offset: 0, next: null, previous: null, items: [] };
    return {
      id, uri, type: "playlist", name: "Playlist", description: "",
      collaborative: false, public: true, snapshot_id: "",
      href: "https://api.spotify.com/v1/playlists/" + id,
      external_urls: ctx && ctx.uri === uri && ctx.external_urls ? ctx.external_urls : { spotify: "https://open.spotify.com/playlist/" + id },
      followers: { href: null, total: 0 }, images: [],
      owner: user("spotify", "Spotify"), tracks: list, items: list,
    };
  }

  // Build album/track/artist/show objects from the last /me/player response
  function fromPlayer(kind, id) {
    const item = lastPlayer && lastPlayer.item;
    if (!item) return null;
    if ((kind === "tracks" || kind === "episodes") && item.id === id) return item;
    if (kind === "albums" && item.album && item.album.id === id)
      return Object.assign({}, item.album, { genres: [], label: "", popularity: 0, copyrights: [],
        tracks: { href: item.album.href + "/tracks", total: item.album.total_tracks || 1, limit: 1, offset: 0, next: null, previous: null, items: [item] } });
    if (kind === "artists") {
      const a = (item.artists || []).concat((item.album && item.album.artists) || []).find((x) => x.id === id);
      if (a) return Object.assign({ images: [], genres: [], popularity: 0, followers: { href: null, total: 0 } }, a);
    }
    if (kind === "shows" && item.show && item.show.id === id) return item.show;
    return null;
  }

  function buildFake(url, auth) {
    const path = pathOf(url);
    if (ME_RE.test(path)) return store.fakeProfile ? fakeMe(auth) : null;
    if (!store.fakePlaylist) return null;
    const m = path.match(RES_RE);
    if (!m) return null;
    return m[1] === "playlists" ? fakePlaylist(m[2]) : fromPlayer(m[1], m[2]);
  }

  // Main fix: Discord only requests /v1/playlists/{id} when context.type === "playlist"
  // (for "album" it uses the context object as-is). The activity's context_uri stays
  // spotify:playlist:..., so Listen Along / Play on Spotify still start the playlist.
  function patchContext(state) {
    const c = state && state.context;
    if (store.rewriteContext && c && c.type === "playlist") { c.type = "album"; return true; }
    return false;
  }

  function rewritePlayerText(text) {
    try {
      const obj = JSON.parse(text);
      lastPlayer = obj;
      return patchContext(obj) ? { obj, text: JSON.stringify(obj) } : null;
    } catch (e) { return null; }
  }

  function rewriteWsData(data) {
    if (typeof data !== "string" || data.indexOf("playlist") === -1) return data;
    try {
      const msg = JSON.parse(data);
      let changed = false;
      for (const p of msg.payloads || []) for (const ev of (p && p.events) || []) {
        const st = ev && ev.event && ev.event.state;
        if (st) { lastPlayer = st; if (patchContext(st)) changed = true; }
      }
      return changed ? JSON.stringify(msg) : data;
    } catch (e) { return data; }
  }

  // ===================== XHR (Discord's superagent uses it) =====================
  // Override status/responseText/... getters on the prototype, so handler order doesn't matter:
  // whoever reads xhr.status first already gets 200 and the fake JSON.
  const XP = XMLHttpRequest.prototype;
  const orig = { open: XP.open, setRequestHeader: XP.setRequestHeader };
  const PROPS = ["status", "statusText", "responseText", "response"];
  const desc = {};
  for (const p of PROPS) desc[p] = Object.getOwnPropertyDescriptor(XP, p);
  const rs = Object.getOwnPropertyDescriptor(XP, "readyState");

  function resolve(xhr) {
    const info = xhr.__srf;
    if (!info) return null;
    if (info.resolved) return info.fake;
    if (rs.get.call(xhr) !== 4) return null;
    info.resolved = true;
    const status = desc.status.get.call(xhr);
    dbg("GET", info.url, "->", status);
    if (status >= 200 && status < 300) {
      if (!PLAYER_RE.test(pathOf(info.url))) return null;
      try { info.fake = rewritePlayerText(desc.responseText.get.call(xhr)); } catch (e) {}
      if (info.fake) { info.fake.keepStatus = true; dbg("context playlist -> album in", pathOf(info.url)); }
      return info.fake;
    }
    if (status !== 403 && status !== 404) return null; // leave 401 (token refresh), 429, etc. to Discord
    const fake = buildFake(info.url, info.auth);
    if (!fake) return null;
    info.fake = { obj: fake, text: JSON.stringify(fake) };
    log("faked", pathOf(info.url), "(was " + status + ")");
    return info.fake;
  }

  const getters = {
    status: (f, xhr) => (f.keepStatus ? desc.status.get.call(xhr) : 200),
    statusText: (f, xhr) => (f.keepStatus ? desc.statusText.get.call(xhr) : "OK"),
    responseText: (f) => f.text,
    response: (f, xhr) => (xhr.responseType === "json" ? f.obj : f.text),
  };

  function patchXhr() {
    XP.open = function (method, url) {
      this.__srf = String(method).toUpperCase() === "GET" && API_RE.test(String(url)) ? { url: String(url) } : null;
      return orig.open.apply(this, arguments);
    };
    XP.setRequestHeader = function (k, v) {
      if (this.__srf && /^authorization$/i.test(k)) this.__srf.auth = v;
      return orig.setRequestHeader.apply(this, arguments);
    };
    for (const p of PROPS) {
      Object.defineProperty(XP, p, {
        configurable: true, enumerable: desc[p].enumerable,
        get() {
          const f = this.__srf ? resolve(this) : null;
          return f ? getters[p](f, this) : desc[p].get.call(this);
        },
      });
    }
  }

  function unpatchXhr() {
    XP.open = orig.open;
    XP.setRequestHeader = orig.setRequestHeader;
    for (const p of PROPS) Object.defineProperty(XP, p, desc[p]);
  }

  // ===================== fetch (just in case) =====================
  const origFetch = window.fetch;
  function patchFetch() {
    window.fetch = async function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      const res = await origFetch.apply(this, arguments);
      if (method !== "GET" || !API_RE.test(url)) return res;
      if (res.ok) {
        if (!PLAYER_RE.test(pathOf(url))) return res;
        const r = rewritePlayerText(await res.clone().text());
        return r ? new Response(r.text, { status: res.status, headers: res.headers }) : res;
      }
      if (res.status !== 403 && res.status !== 404) return res;
      let auth = "";
      try { auth = new Headers((init && init.headers) || (input && input.headers) || {}).get("authorization") || ""; } catch (e) {}
      const fake = buildFake(url, auth);
      if (!fake) return res;
      log("faked (fetch)", pathOf(url), "(was " + res.status + ")");
      return new Response(JSON.stringify(fake), { status: 200, headers: { "content-type": "application/json" } });
    };
  }

  // ===================== WebSocket dealer.spotify.com (PLAYER_STATE_CHANGED events) =====================
  const WSP = WebSocket.prototype;
  const wsDesc = Object.getOwnPropertyDescriptor(WSP, "onmessage");
  function patchWs() {
    Object.defineProperty(WSP, "onmessage", {
      configurable: true, enumerable: wsDesc.enumerable,
      get() { return wsDesc.get.call(this); },
      set(h) {
        if (typeof h === "function" && /dealer\.spotify\.com/.test(this.url || "")) {
          const origHandler = h;
          h = function (ev) {
            const nd = rewriteWsData(ev.data);
            if (nd !== ev.data) {
              dbg("WS: context playlist -> album");
              ev = { data: nd, type: ev.type, origin: ev.origin, target: ev.target, currentTarget: ev.currentTarget };
            }
            return origHandler.call(this, ev);
          };
        }
        wsDesc.set.call(this, h);
      },
    });
  }
  function unpatchWs() { Object.defineProperty(WSP, "onmessage", wsDesc); }

  // ===================== Own /v1/me/player polling -> SPOTIFY_PLAYER_STATE =====================
  // Discord gets live updates via the dealer WS + /me/notifications/player subscription; if that
  // doesn't work, SpotifyStore never gets a track. So we feed the store ourselves, in Discord's format.
  let pollTimer = null, polling = false, last = null, refreshing = false;

  function getAcc() {
    try {
      const sd = shelter.flux.stores.SpotifyStore.getActiveSocketAndDevice();
      if (sd && sd.socket && sd.socket.accessToken) return { id: sd.socket.accountId, token: sd.socket.accessToken };
    } catch (e) {}
    const a = spotifyAccount();
    return a && a.accessToken ? { id: a.id, token: a.accessToken } : null;
  }

  async function refreshToken(id) {
    if (refreshing) return;
    refreshing = true;
    try {
      await shelter.http.ready;
      const r = await shelter.http.get({ url: "/users/@me/connections/spotify/" + id + "/access-token" });
      const token = r && r.body && r.body.access_token;
      if (token) {
        shelter.flux.dispatcher.dispatch({ type: "SPOTIFY_ACCOUNT_ACCESS_TOKEN", accountId: id, accessToken: token });
        log("access token refreshed");
      }
    } catch (e) { log("failed to refresh access token", e); }
    refreshing = false;
  }

  // Same mapping Discord does in its own player-state handler
  function toTrack(d) {
    if (!d) return null;
    if (d.type === "track") {
      return {
        id: d.linked_from && d.linked_from.id ? d.linked_from.id : d.id,
        name: d.name, duration: d.duration_ms, type: "track",
        album: { id: (d.album && d.album.id) || "", name: (d.album && d.album.name) || "",
                 image: d.album && d.album.images ? d.album.images[0] : undefined, type: (d.album && d.album.type) || "album" },
        artists: Array.isArray(d.artists) ? d.artists.filter((a) => a && a.id && a.name) : [],
        isLocal: !!d.is_local,
      };
    }
    if (d.type === "episode") {
      return {
        id: d.id, name: d.name, duration: d.duration_ms, type: "episode",
        album: { id: (d.show && d.show.id) || "", name: (d.show && d.show.name) || "",
                 image: d.show && d.show.images ? d.show.images[0] : undefined, type: "show" },
        artists: [], isLocal: false,
      };
    }
    return null;
  }

  function pushState(accountId, body, force) {
    const track = body ? toTrack(body.item) : null;
    const isPlaying = !!(body && body.is_playing && track);
    const progress = (body && body.progress_ms) || 0;
    const ctx = body && body.context ? body.context : null;
    const now = { trackId: track && track.id, isPlaying, ctx: ctx && ctx.uri, start: Date.now() - progress };
    // Only dispatch on track change, play/pause, context change or seek
    if (!force && last && last.trackId === now.trackId && last.isPlaying === now.isPlaying &&
        last.ctx === now.ctx && Math.abs(last.start - now.start) < 2500) return;
    last = now;
    const device = body && body.device ? Object.assign({}, body.device, { is_active: true }) : undefined;
    shelter.flux.dispatcher.dispatch({
      type: "SPOTIFY_PLAYER_STATE", accountId, track, isPlaying,
      volumePercent: device ? device.volume_percent : 0,
      repeat: !!body && body.repeat_state !== "off", position: progress, context: ctx, device,
    });
  }

  async function poll(force) {
    if (polling) return;
    polling = true;
    try {
      const acc = getAcc();
      if (!acc) { setStatus("No connected Spotify account / active device"); return; }
      const res = await origFetch("https://api.spotify.com/v1/me/player?additional_types=track%2Cepisode",
        { headers: { authorization: "Bearer " + acc.token } });
      if (res.status === 401) return void refreshToken(acc.id);
      if (res.status === 204) return void pushState(acc.id, null, force);
      if (!res.ok) { dbg("poll ->", res.status); setStatus("Poll failed: HTTP " + res.status); return; }
      const body = await res.json();
      lastPlayer = body;
      pushState(acc.id, body, force);
    } catch (e) { dbg("poll error", e); setStatus("Poll error: " + (e && e.message)); }
    finally { polling = false; }
  }

  function restartPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (!store.polling) return;
    const sec = Math.max(2, Math.min(60, Number(store.pollInterval) || DEFAULTS.pollInterval));
    pollTimer = setInterval(poll, sec * 1000);
  }

  // ===================== Diagnostics =====================
  function onState(d) {
    const t = d.track;
    const artists = t && t.artists ? t.artists.map((a) => a.name).join(", ") : "";
    setStatus(t ? (d.isPlaying ? "▶ " : "⏸ ") + t.name + (artists ? " — " + artists : "") : "Nothing playing");
    dbg("SPOTIFY_PLAYER_STATE:", t ? t.name : null, "| playing:", d.isPlaying, "| context:", d.context && d.context.uri);
  }
  const onProfile = (d) => dbg("SPOTIFY_PROFILE_UPDATE: isPremium =", d.isPremium);

  // ===================== Settings UI (hyperscript, no JSX/build step needed) =====================
  function settings() {
    const h = shelter.solidH.h;
    const ui = shelter.ui;
    const sw = (key, title, note, onChange) =>
      h(ui.SwitchItem, {
        checked: () => !!store[key],
        note,
        onChange: (v) => { store[key] = v; if (onChange) onChange(v); },
      }, title);
    const header = (text) => h(ui.Header, { tag: ui.HeaderTags.H5 }, text);

    const el = h("div", null,
      header("Status"),
      h(ui.Text, null, () => status()),
      h(ui.Divider, { mt: true, mb: true }),

      header("Fixes"),
      sw("rewriteContext", "Skip playlist lookup",
        "Marks playlist contexts as albums so Discord never calls the blocked /v1/playlists endpoint. Listen Along still plays the playlist. Side effect: private playlists are no longer hidden from your activity."),
      sw("fakePlaylist", "Fake blocked playlist / album / track responses",
        "Replaces 403/404 answers from /v1/playlists, /albums, /tracks, /artists with data from /v1/me/player."),
      sw("fakeProfile", "Fake blocked profile (/v1/me)",
        "Discord reads your Premium status from this endpoint."),
      sw("premium", "Report Premium account",
        "Required for Listen Along / Play on Spotify buttons."),
      h(ui.Text, null, "Account country for fake profile (optional, e.g. TR)"),
      h(ui.TextBox, {
        value: () => store.country,
        placeholder: "empty = not sent",
        maxlength: 2,
        onInput: (v) => { store.country = String(v || "").trim(); },
      }),
      h(ui.Divider, { mt: true, mb: true }),

      header("Polling"),
      sw("polling", "Poll player state",
        "Fetches /v1/me/player periodically and pushes the state to Discord. Needed when Discord's own live updates don't arrive.",
        restartPolling),
      h(ui.Text, null, () => "Poll interval: " + store.pollInterval + " s"),
      h(ui.Slider, {
        value: () => store.pollInterval,
        min: 2, max: 30, step: 1,
        onInput: (v) => { store.pollInterval = Number(v); restartPolling(); },
      }),
      h("div", { style: "margin-top:12px" },
        h(ui.Button, { onClick: (e) => { last = null; poll(true); } }, "Refresh now")),
      h(ui.Divider, { mt: true, mb: true }),

      header("Debug"),
      sw("debug", "Verbose logging", "Logs every Spotify API request and player state to the console.")
    );
    return typeof el === "function" ? el() : el;
  }

  // ===================== Lifecycle =====================
  return {
    onLoad() {
      patchXhr(); patchFetch(); patchWs();
      try {
        shelter.flux.dispatcher.subscribe("SPOTIFY_PLAYER_STATE", onState);
        shelter.flux.dispatcher.subscribe("SPOTIFY_PROFILE_UPDATE", onProfile);
      } catch (e) {}
      restartPolling();
      if (store.polling) setTimeout(() => poll(), 2000);
      log("loaded");
    },
    onUnload() {
      clearInterval(pollTimer); pollTimer = null; last = null;
      unpatchXhr(); unpatchWs(); window.fetch = origFetch; lastPlayer = null;
      try {
        shelter.flux.dispatcher.unsubscribe("SPOTIFY_PLAYER_STATE", onState);
        shelter.flux.dispatcher.unsubscribe("SPOTIFY_PROFILE_UPDATE", onProfile);
      } catch (e) {}
    },
    settings,
  };
})()
