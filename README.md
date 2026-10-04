# Spotify RPC Fix

A [shelter](https://shelter.uwu.network/) plugin for Discord that restores the Spotify activity ("Listening to Spotify") when the Spotify Web API returns:

```json
{ "error": { "status": 403, "message": "Spotify is unavailable in this country" } }
```

Spotify itself works fine with a subscription, but some Web API endpoints Discord relies on are blocked for certain regions. Discord gives up on the first failed request, and your activity never shows up. `/v1/me/player` keeps working, and this plugin uses it to get everything back.

## Caveats

- With `Skip playlist lookup` enabled, Discord can't tell private playlists from public ones, so private playlists can appear as your activity context

## Install

1. Install [shelter](https://shelter.uwu.network/install).
2. Open Discord → **User Settings → shelter Settings → Add Plugin** and paste the URL below.
   ```
   https://raw.githubusercontent.com/AS7RIDENIED/Spotify-RPCure/refs/heads/main/shelter/
   ```
4. Enable this plugin.

## How it works

| Problem | Fix |
| --- | --- |
| Discord requests `/v1/playlists/{id}` to check whether the playlist is public, and gets 403 | The playlist context from `/v1/me/player` and the dealer WebSocket is marked as `album`, so Discord skips the lookup. `context_uri` stays `spotify:playlist:…`, so Listen Along still plays the playlist |
| `/v1/me` returns 403, so Discord doesn't know you have Premium | A fake profile is built from your Discord Spotify connection, with `product: "premium"` |
| Other 403/404 lookups (`/albums`, `/tracks`, `/artists`) | Rebuilt from the last `/v1/me/player` response |
| Live player updates never arrive | The plugin polls `/v1/me/player` and dispatches `SPOTIFY_PLAYER_STATE` in Discord's own format |

Responses with status 401 (token refresh), 429 and 2xx are left untouched, except for the context rewrite.


