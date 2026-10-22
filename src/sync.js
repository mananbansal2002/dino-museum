/**
 * Optional cross-instance sync layer.
 *
 * On a single Node process rooms live purely in memory (fast, zero config).
 * On Vercel a function instance is a single point of truth for the rooms it
 * holds, and two friends in the same room code could land on different
 * instances. When Upstash Redis credentials are present we mirror the room
 * roster + an event stream into Redis so every instance can fan out events.
 *
 * Uses the Upstash REST API (plain fetch), so there is no extra dependency.
 *
 * Event stream layout (per room):
 *   dm:seq:<code>      monotonically increasing sequence number
 *   dm:evt:<code>      list of "<seq>|<json>" entries, trimmed to the last 200
 *   dm:players:<code>  hash id -> roster entry, stamped with `seen` (ms) and
 *                      `inst` (owning instance); entries the owner stopped
 *                      refreshing are treated as gone (dead instance)
 *
 * Sequence allocation and RPUSH happen inside one Lua script, so list order
 * always matches sequence order (two instances can never interleave a lower
 * seq after a higher one, which would make pollers skip it forever), and a
 * whole batch of events costs a single HTTP round trip. Because every seq
 * gets exactly one list entry, a poll only fetches the tail it has not seen,
 * and a hole between the last seq we know and the oldest entry still in the
 * list means events were trimmed before we read them (reported via onGap).
 */

const DEFAULTS = {
  pollMs: 600, // poll period while players from other instances share the room
  idlePollMs: 2500, // poll period while the room only has our own players
  flushMs: 120,
  timeoutMs: 3000, // per Redis request: a stalled call must never block a join
  staleMs: 45000, // roster entries not refreshed for this long are dead
};
const MAX_EVENTS = 200;
const TTL_S = 60 * 60 * 24;
/** Membership events are idempotent on the receiving side, so safe to resend. */
const RETRY_TYPES = new Set(["playerJoined", "playerLeft", "playerRejoined"]);
const MAX_RETRIES = 2;

// KEYS[1] = seq key, KEYS[2] = list key, ARGV = encoded events
const PUBLISH_SCRIPT = `
local out = 0
for i = 1, #ARGV do
  out = redis.call('INCR', KEYS[1])
  redis.call('RPUSH', KEYS[2], out .. '|' .. ARGV[i])
end
redis.call('LTRIM', KEYS[2], -${MAX_EVENTS}, -1)
redis.call('EXPIRE', KEYS[2], ${TTL_S})
redis.call('EXPIRE', KEYS[1], ${TTL_S})
return out
`;

// KEYS[1] = seq key, KEYS[2] = list key, ARGV[1] = last seq seen (-1 = none)
// Returns {seq} when there is nothing new, else {seq, entries newer than ARGV[1]}.
const POLL_SCRIPT = `
local seq = tonumber(redis.call('GET', KEYS[1]) or '0')
local known = tonumber(ARGV[1])
if known < 0 or seq <= known then return {seq} end
local n = seq - known
if n > ${MAX_EVENTS} then n = ${MAX_EVENTS} end
return {seq, redis.call('LRANGE', KEYS[2], -n, -1)}
`;

// KEYS[1] = roster hash, ARGV[1] = field, ARGV[2] = value expected to be there.
// Deletes a stale entry only if its owner has not refreshed it meanwhile.
const DROP_STALE_SCRIPT = `
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  return redis.call('HDEL', KEYS[1], ARGV[1])
end
return 0
`;

function decode(item) {
  const s = String(item);
  const bar = s.indexOf("|");
  if (bar < 1) return null;
  const q = Number(s.slice(0, bar));
  if (!Number.isFinite(q)) return null;
  try {
    const ev = JSON.parse(s.slice(bar + 1));
    if (!ev || typeof ev !== "object") return null;
    ev.q = q;
    return ev;
  } catch {
    return null;
  }
}

/**
 * @param {object} [options] overrides for DEFAULTS, plus `url` / `token`
 *   (default: the UPSTASH_REDIS_REST_URL / _TOKEN environment variables).
 */
export function createSync(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const url = options.url ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = options.token ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  const enabled = Boolean(url && token);
  const instanceId = Math.random().toString(36).slice(2, 10);
  const lastSeq = new Map(); // roomCode -> last seen seq (undefined = not primed)
  const pollers = new Map(); // roomCode -> { timer, stopped, pending:Set }
  const queues = new Map(); // roomCode -> pending events
  const rosterChains = new Map(); // roomCode -> tail of the roster write chain
  let flushTimer = null;

  async function cmd(...args) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`redis ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`redis ${json.error}`);
    return json.result;
  }

  /**
   * Roster writes for a room run one after another. Two unawaited fetches
   * can otherwise reach Redis in either order, and an HSET landing after
   * the HDEL of the same player would resurrect a player who already left.
   */
  function rosterWrite(code, label, fn) {
    const prev = rosterChains.get(code) || Promise.resolve();
    const next = prev.then(fn).catch((e) => console.warn(`[sync] roster ${label} failed`, e.message));
    rosterChains.set(code, next);
    next.then(() => {
      if (rosterChains.get(code) === next) rosterChains.delete(code);
    });
    return next;
  }

  const stamp = (p) => JSON.stringify({ ...p, seen: Date.now(), inst: instanceId });

  function enqueue(code, ev, front = false) {
    let q = queues.get(code);
    if (!q) queues.set(code, (q = []));
    if (front) q.unshift(ev);
    else q.push(ev);
    if (!flushTimer) flushTimer = setTimeout(flush, cfg.flushMs);
  }

  async function flush() {
    flushTimer = null;
    const batches = Array.from(queues.entries());
    queues.clear();
    await Promise.all(
      batches.map(async ([code, events]) => {
        if (!events.length) return;
        try {
          await cmd(
            "EVAL",
            PUBLISH_SCRIPT,
            2,
            `dm:seq:${code}`,
            `dm:evt:${code}`,
            ...events.map(({ retries, ...e }) => JSON.stringify(e))
          );
        } catch (e) {
          // Joins/leaves must not be lost (a lost playerLeft leaves a frozen
          // avatar on every other instance): resend them with the next batch.
          // Chat/actions are not idempotent, and states are superseded anyway.
          const again = events.filter((ev) => RETRY_TYPES.has(ev.t) && (ev.retries || 0) < MAX_RETRIES);
          for (const ev of again.reverse()) enqueue(code, { ...ev, retries: (ev.retries || 0) + 1 }, true);
          console.warn("[sync] publish failed", e.message, again.length ? `(retrying ${again.length})` : "");
        }
      })
    );
  }

  function touchPlayers(code, players) {
    if (!enabled || !players.length) return Promise.resolve();
    const key = `dm:players:${code}`;
    return rosterWrite(code, "write", async () => {
      const flat = [];
      for (const p of players) flat.push(p.id, stamp(p));
      await cmd("HSET", key, ...flat);
      await cmd("EXPIRE", key, TTL_S);
    });
  }

  async function prime(code) {
    if (lastSeq.get(code) !== undefined) return;
    try {
      const seq = await cmd("GET", `dm:seq:${code}`);
      // Another call may have primed the room while we awaited.
      if (lastSeq.get(code) === undefined) lastSeq.set(code, Number(seq) || 0);
    } catch {
      /* leave unprimed: the first poll adopts the newest seq without replaying */
    }
  }

  return {
    enabled,
    instanceId,
    /** How often the shared roster must be refreshed to count as alive. */
    staleMs: cfg.staleMs,

    /** Mirror the full roster of a room into Redis (replaces it). */
    setRoster(code, players) {
      if (!enabled) return Promise.resolve();
      const key = `dm:players:${code}`;
      return rosterWrite(code, "write", async () => {
        await cmd("DEL", key);
        const flat = [];
        for (const p of players) flat.push(p.id, stamp(p));
        if (flat.length) await cmd("HSET", key, ...flat);
        await cmd("EXPIRE", key, TTL_S);
      });
    },

    /** Add or refresh players in the shared roster without touching others. */
    touchPlayers,

    /** Add or update one player in the shared roster without touching others. */
    addPlayer(code, player) {
      return touchPlayers(code, [player]);
    },

    /** Remove one player from the shared roster. */
    removePlayer(code, id) {
      if (!enabled) return Promise.resolve();
      return rosterWrite(code, "delete", () => cmd("HDEL", `dm:players:${code}`, id));
    },

    /**
     * Everyone (local + other instances) currently in the room, or null when
     * Redis could not be read. Entries whose owner stopped refreshing them
     * (instance killed before it could clean up) are dropped and deleted.
     */
    async getRoster(code) {
      if (!enabled) return null;
      const key = `dm:players:${code}`;
      try {
        const raw = (await cmd("HGETALL", key)) || [];
        const out = [];
        const now = Date.now();
        for (let i = 0; i < raw.length; i += 2) {
          let entry = null;
          try {
            entry = JSON.parse(raw[i + 1]);
          } catch {
            /* malformed: treated as stale below */
          }
          const seen = Number(entry?.seen);
          if (entry && entry.id && Number.isFinite(seen) && now - seen <= cfg.staleMs) {
            out.push(entry);
          } else {
            const [field, value] = [raw[i], raw[i + 1]];
            rosterWrite(code, "cleanup", () => cmd("EVAL", DROP_STALE_SCRIPT, 1, key, field, value));
          }
        }
        return out;
      } catch {
        return null;
      }
    },

    /**
     * Publish an event so other instances can relay it. Events are batched
     * per room for flushMs; consecutive "state" events from the same player
     * are coalesced to the latest one. `ts` lets receivers replay the batch
     * at the pace it was produced instead of all at once.
     */
    publish(code, event) {
      if (!enabled) return;
      const ev = { ...event, i: instanceId, ts: Date.now() };
      const q = queues.get(code);
      if (q && ev.t === "state" && ev.p && ev.p.id) {
        const at = q.findIndex((e) => e.t === "state" && e.p && e.p.id === ev.p.id);
        if (at !== -1) q.splice(at, 1);
      }
      enqueue(code, ev);
    },

    /**
     * Start polling a room for events published by other instances.
     *   onEvent(ev)  each new event, replayed at its original pace
     *   hooks.shared()  true while players from other instances are in the
     *                   room (poll fast), false otherwise (poll slowly)
     *   hooks.onGap()   events were trimmed before we could read them; the
     *                   caller should resync its mirror of the room
     */
    async watch(code, onEvent, hooks = {}) {
      if (!enabled) return;
      if (pollers.has(code)) return;
      const poller = { timer: null, stopped: false, pending: new Set() };
      pollers.set(code, poller);
      await prime(code);
      if (poller.stopped) {
        if (!pollers.has(code)) lastSeq.delete(code);
        return;
      }

      const deliver = (ev) => {
        if (poller.stopped) return;
        try {
          onEvent(ev);
        } catch (e) {
          console.warn("[sync] event handler failed", e.message);
        }
      };

      const gap = (why) => {
        console.warn(`[sync] ${code}: ${why}, resyncing the room`);
        try {
          hooks.onGap?.();
        } catch (e) {
          console.warn("[sync] gap handler failed", e.message);
        }
      };

      const schedule = () => {
        if (poller.stopped) return;
        const shared = hooks.shared ? hooks.shared() : true;
        poller.timer = setTimeout(tick, shared ? cfg.pollMs : cfg.idlePollMs);
      };

      const tick = async () => {
        poller.timer = null;
        try {
          const known = lastSeq.get(code);
          const res = await cmd("EVAL", POLL_SCRIPT, 2, `dm:seq:${code}`, `dm:evt:${code}`, known ?? -1);
          if (poller.stopped) return;
          const seq = Number(Array.isArray(res) ? res[0] : 0) || 0;
          const items = Array.isArray(res) && Array.isArray(res[1]) ? res[1] : [];
          if (known === undefined) {
            lastSeq.set(code, seq); // start from "now": never replay old events
            return;
          }
          if (seq < known) {
            // The stream expired and restarted: adopt it, and resync.
            lastSeq.set(code, seq);
            gap("event stream restarted");
            return;
          }
          const fresh = [];
          for (const item of items) {
            const ev = decode(item);
            if (ev && ev.q > known) fresh.push(ev);
          }
          lastSeq.set(code, seq);
          const oldest = fresh.length ? fresh[0].q : seq + 1;
          if (seq > known && oldest > known + 1) gap(`missed events ${known + 1}-${oldest - 1}`);

          // A poll returns up to pollMs worth of events at once. Replay each
          // instance's events at the spacing they were published with, so
          // remote avatars move smoothly instead of fast-forwarding through
          // the whole burst and then freezing until the next poll.
          const base = new Map(); // instance -> ts of its first event in the batch
          for (const ev of fresh) {
            if (ev.i === instanceId) continue; // already delivered locally
            const ts = Number(ev.ts);
            if (!Number.isFinite(ts)) {
              deliver(ev);
              continue;
            }
            if (!base.has(ev.i)) base.set(ev.i, ts);
            const delay = Math.min(cfg.pollMs, Math.max(0, ts - base.get(ev.i)));
            if (delay < 5) {
              deliver(ev);
              continue;
            }
            const t = setTimeout(() => {
              poller.pending.delete(t);
              deliver(ev);
            }, delay);
            poller.pending.add(t);
          }
        } catch {
          /* transient network error / timeout: retry next tick */
        } finally {
          schedule();
        }
      };
      tick();
    },

    unwatch(code) {
      const p = pollers.get(code);
      if (p) {
        p.stopped = true;
        clearTimeout(p.timer);
        for (const t of p.pending) clearTimeout(t);
        p.pending.clear();
      }
      pollers.delete(code);
      lastSeq.delete(code);
    },

    /** Start a room from "now" so we never replay ancient events. Idempotent. */
    async primeRoom(code) {
      if (!enabled) return;
      await prime(code);
    },

    /** Number of rooms currently being polled (diagnostics / tests). */
    get watching() {
      return pollers.size;
    },
  };
}
