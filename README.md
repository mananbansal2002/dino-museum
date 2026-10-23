# 🦖 Dinosaur Museum

A shared, browser based 3D museum you can walk around with friends. Fifty-three
skeletons, battle screenings in the theatre, a fossil dig site, an ice cream
court, a live minimap and a customisable avatar — all rendered with Three.js
and kept in sync over Socket.IO.

![rooms](https://img.shields.io/badge/halls-19-blue) ![exhibits](https://img.shields.io/badge/exhibits-53-green) ![battles](https://img.shields.io/badge/screenings-14-orange)

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

Open the page, type a name and press **Enter the museum**. The room code in
the top bar is in the URL as well, so sharing the link drops your friends
into the same hall.

## Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | walk |
| `Shift` | run |
| `Space` | jump |
| mouse | look (click the canvas to capture the pointer) |
| `E` | interact (exhibit, guide, photo spot, puzzle, ice cream) |
| `V` | roar |
| `F` | dig for fossils / feed the dinosaurs |
| `G` | take a photo |
| `C` | first person ↔ third person camera |
| `M` | resize the minimap |
| `T` | chat |
| `L` | mute |
| `Esc` | release the mouse |

## What is inside

- **19 halls** — Cretaceous, Predator Bay, Triassic, Jurassic, Marine, the
  Rotunda, the Entrance Atrium and the Ice Cream Court, joined by corridors.
- **53 species** with skeletons, plaques, fun facts and real discovery dates.
- **14 battle screenings** shown on the theatre screen, complete with
  commentary, hit counters and sound effects.
- **The dig site** where visitors unearth fossils, and the **bone puzzle**
  table in the lobby.
- **Ice cream court** with flavours, scoops, styles and toppings — the order
  shows up on your avatar.
- **Live minimap** with the halls, the exhibits and every other visitor.
- **Customisable avatar**: skin, hair, shirt, trousers, shoes and accessories.

## Project layout

```
api/socket.js        Vercel serverless function (mounts the Socket.IO server)
src/museum-server.js Express + Socket.IO application shared by dev and Vercel
src/sync.js          optional Upstash Redis sync for multi instance rooms
public/index.html    the page shell
public/js/world.js   the museum itself: rooms, walls, props, exhibits
public/js/*.js       player, remotes, minimap, cinema, ui, audio, fx, net
scripts/check.mjs    data + layout validation (npm run check)
scripts/smoke.mjs    end to end server test with two visitors
scripts/journey.mjs  drives the real client in headless Chrome
```

## Checks and tests

```bash
npm run check        # catalogue, floor plan, walls, module graph, dom contract
npm run smoke        # boots the server, two clients join, chat/move/leave
npm test             # check + smoke
npm run journey      # real browser run (needs the dev server on :3111)
node scripts/live.mjs https://dino-museum-ten.vercel.app/ 300 --crowd
                     # long run: connection, frame loop, npc path stress
```

`npm run check` is the interesting one: it builds the real museum, measures
every model with `THREE.Box3` and fails if a dinosaur clips a wall, if two
dinosaurs overlap, if a hall is not sealed or if a doorway is blocked.

## Deploying

The app runs on Vercel — `api/socket.js` is the serverless entry point and
`vercel.json` routes `/api/socket` to it while everything else is served as
static files.

```bash
npx vercel --prod
```

The client only ever uses the websocket transport, so no sticky sessions are
needed. To run more than one instance (so rooms survive a cold start) set
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; the server then
syncs rosters and events through Redis.

A Vercel function is killed at `maxDuration` (300 s on Hobby), so every visitor
gets a new socket about every five minutes. That is expected: `public/js/net.js`
resumes the same player, in the same room and at the same spot, and the museum
keeps rendering — the gap is roughly two seconds. For sessions without any drop
at all, run `server.js` on a long-lived host instead.

## Notes

- Three.js r160 and the Socket.IO browser client are vendored in
  `public/vendor`, so the page has no build step and no CDN dependency.
- The museum is generated from data: `public/js/species.js` holds the
  catalogue, `public/js/exhibits.js` the exhibits and battles, and
  `public/js/world.js` places everything on a 32×30 grid of six metre cells.

## Still to build

The museum is playable today, but these features are on the list and are not
implemented yet:

**Gameplay**
- Guided tour mode — a scripted route through all 19 halls with commentary.
- Collectible museum passport: a stamp for every hall, species and fossil.
- Dinosaur "friendship" meter — feed, pet and photo dinosaurs to raise their
  mood, then pose with them.
- More fossil digging: deeper layers, rare specimens and a real stratigraphy
  of the dig site.
- A puzzle hunt where the clues are spread over plaques, holograms and the
  timeline pillar.
- Leaderboard and collectible hall records that persist between visits.
- Ambient life: pterosaurs circling the rotunda, fish in the marine hall,
  dust motes in the light shafts.

**Multiplayer**
- Private rooms with a password and a public directory of open museums.
- Voice chat (push to talk) next to the text chat.
- Group photo mode — stack up and pose, the camera flies around the group.
- Shared theatre: one visitor starts the screening, everybody watches it in
  the same room with synchronised commentary.
- Emotes and small props you can throw, plus a snowball fight in the atrium.
- Server-side authority for the score, so it cannot be tampered with.

**Presentation**
- Real footprints and tracks in the floor, droppings and eggs in the halls.
- Better hall identity: unique lighting, colour grading and music per hall.
- A loading screen with a progress bar instead of a spinner.
- Accessibility pass: colour blind safe palette, subtitles for the
  screenings, remappable keys and a "reduce motion" setting.
- Mobile controls: a virtual joystick and touch look.
- Photo mode with filters, a timer and a downloadable frame.
- A day/night cycle that changes the light in the atrium.

**Platform**
- A "play again" summary screen that shows everything you collected.
- Versioned save of the museum state (which fossils are dug, the passport).
- PWA support so the museum can be installed on a phone.
- A live deployment health badge and error reporting to a small dashboard.

