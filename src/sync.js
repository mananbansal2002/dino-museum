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
 *   dm:seq:<code>  monotonically increasing sequence number
 *   dm:evt:<code>  list of "<seq>|<json>" entries, trimmed to the last 200
 *
 * Sequence allocation and RPUSH happen inside one Lua script, so list order
 * always matches sequence order (two instances can never interleave a lower
 * seq after a higher one, which would make pollers skip it forever), and a
 * whole batch of events costs a single HTTP round trip.
 */

const POLL_MS = 600;
const FLUSH_MS = 120;
const MAX_EVENTS = 200;
const TTL_S = 60 * 60 * 24;

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

function decode(item) {
  const s = String(item);
  const bar = s.indexOf("|");
  if (bar < 1) return null;
  const q = Number(s.slice(0, bar));
  if (!Number.isFinite(q)) return null;
  try {
    const ev = JSON.parse(s.slice(bar + 1));
    ev.q = q;
    return ev;
  } catch {
    return null;
  }
}

export function createSync() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const enabled = Boolean(url && token);
  const instanceId = Math.random().toString(36).slice(2, 10);
  const lastSeq = new Map(); // roomCode -> last seen seq (undefined = not primed)
  const pollers = new Map(); // roomCode -> { timer, busy }
  const queues = new Map(); // roomCode -> pending events
  let flushTimer = null;

  async function cmd(...args) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`redis ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`redis ${json.error}`);
    return json.result;
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
            ...events.map((e) => JSON.stringify(e))
          );
        } catch (e) {
          console.warn("[sync] publish failed", e.message);
        }
      })
    );
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

    /** Mirror the full roster of a room into Redis (replaces it). */
    async setRoster(code, players) {
      if (!enabled) return;
      try {
        const key = `dm:players:${code}`;
        await cmd("DEL", key);
        const flat = [];
        for (const p of players) flat.push(p.id, JSON.stringify(p));
        if (flat.length) await cmd("HSET", key, ...flat);
        await cmd("EXPIRE", key, TTL_S);
      } catch (e) {
        console.warn("[sync] roster write failed", e.message);
      }
    },

    /** Add or update one player in the shared roster without touching others. */
    async addPlayer(code, player) {
      if (!enabled) return;
      try {
        const key = `dm:players:${code}`;
        await cmd("HSET", key, player.id, JSON.stringify(player));
        await cmd("EXPIRE", key, TTL_S);
      } catch (e) {
        console.warn("[sync] roster write failed", e.message);
      }
    },

    /** Remove one player from the shared roster. */
    async removePlayer(code, id) {
      if (!enabled) return;
      try {
        await cmd("HDEL", `dm:players:${code}`, id);
      } catch (e) {
        console.warn("[sync] roster delete failed", e.message);
      }
    },

    /** Everyone (local + other instances) currently in the room. */
    async getRoster(code) {
      if (!enabled) return null;
      try {
        const raw = (await cmd("HGETALL", `dm:players:${code}`)) || [];
        const out = [];
        for (let i = 0; i < raw.length; i += 2) {
          try {
            out.push(JSON.parse(raw[i + 1]));
          } catch {
            /* ignore malformed */
          }
        }
        return out;
      } catch {
        return null;
      }
    },

    /**
     * Publish an event so other instances can relay it. Events are batched
     * per room for FLUSH_MS; consecutive "state" events from the same player
     * are coalesced to the latest one.
     */
    publish(code, event) {
      if (!enabled) return;
      const ev = { ...event, i: instanceId };
      let q = queues.get(code);
      if (!q) queues.set(code, (q = []));
      if (ev.t === "state" && ev.p && ev.p.id) {
        const at = q.findIndex((e) => e.t === "state" && e.p && e.p.id === ev.p.id);
        if (at !== -1) q.splice(at, 1);
      }
      q.push(ev);
      if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    },

    /** Start polling a room for events published by other instances. */
    async watch(code, onEvent) {
      if (!enabled) return;
      if (pollers.has(code)) return;
      const poller = { timer: null, busy: false, stopped: false };
      pollers.set(code, poller);
      await prime(code);
      if (poller.stopped) {
        if (!pollers.has(code)) lastSeq.delete(code);
        return;
      }

      const tick = async () => {
        if (poller.busy || poller.stopped) return;
        poller.busy = true;
        try {
          const raw = (await cmd("LRANGE", `dm:evt:${code}`, 0, -1)) || [];
          if (poller.stopped) return;
          const known = lastSeq.get(code);
          let newest = known ?? 0;
          for (const item of raw) {
            const ev = decode(item);
            if (!ev) continue;
            if (ev.q > newest) newest = ev.q;
            if (known === undefined || ev.q <= known) continue;
            if (ev.i === instanceId) continue; // already delivered locally
            try {
              onEvent(ev);
            } catch (e) {
              console.warn("[sync] event handler failed", e.message);
            }
          }
          lastSeq.set(code, newest);
        } catch {
          /* transient network error: retry next tick */
        } finally {
          poller.busy = false;
        }
      };
      poller.timer = setInterval(tick, POLL_MS);
      tick();
    },

    unwatch(code) {
      const p = pollers.get(code);
      if (p) {
        p.stopped = true;
        clearInterval(p.timer);
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
