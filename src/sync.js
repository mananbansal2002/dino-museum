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
 */

const POLL_MS = 600;

export function createSync() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const enabled = Boolean(url && token);
  const instanceId = Math.random().toString(36).slice(2, 10);
  const lastSeq = new Map(); // roomCode -> last seen global seq
  const pollers = new Map(); // roomCode -> timer

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
    return json.result;
  }

  async function currentSeq() {
    try {
      const seq = await cmd("INCR", "dm:seq");
      return Number(seq) || 0;
    } catch {
      return 0;
    }
  }

  return {
    enabled,
    instanceId,

    /** Mirror the roster of a room into Redis. */
    async setRoster(code, players) {
      if (!enabled) return;
      try {
        const key = `dm:players:${code}`;
        await cmd("DEL", key);
        const flat = [];
        for (const p of players) flat.push(p.id, JSON.stringify(p));
        if (flat.length) await cmd("HSET", key, ...flat);
        await cmd("EXPIRE", key, 60 * 60 * 24);
      } catch (e) {
        console.warn("[sync] roster write failed", e.message);
      }
    },

    /** Everyone (local + other instances) currently in the room. */
    async getRoster(code) {
      if (!enabled) return null;
      try {
        const raw = await cmd("HGETALL", `dm:players:${code}`);
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

    /** Publish an event so other instances can relay it. */
    async publish(code, event) {
      if (!enabled) return;
      try {
        const seq = await cmd("INCR", "dm:seq");
        const payload = JSON.stringify({ ...event, i: instanceId, q: Number(seq) || 0 });
        await cmd("RPUSH", `dm:evt:${code}`, payload);
        await cmd("LTRIM", `dm:evt:${code}`, -200, -1);
        await cmd("EXPIRE", `dm:evt:${code}`, 60 * 60 * 24);
        if (!lastSeq.has(code)) lastSeq.set(code, Number(seq) || 0);
      } catch (e) {
        console.warn("[sync] publish failed", e.message);
      }
    },

    /** Start polling a room for events published by other instances. */
    watch(code, onEvent) {
      if (!enabled) return;
      if (pollers.has(code)) return;
      const tick = async () => {
        try {
          const raw = await cmd("LRANGE", `dm:evt:${code}`, 0, -1);
          const known = lastSeq.get(code) ?? 0;
          for (const item of raw || []) {
            let ev;
            try {
              ev = JSON.parse(item);
            } catch {
              continue;
            }
            if (typeof ev.q !== "number" || ev.q <= known) continue;
            if (ev.i === instanceId) continue; // already delivered locally
            onEvent(ev);
          }
          const newest = (raw || [])
            .map((i) => {
              try {
                return JSON.parse(i).q || 0;
              } catch {
                return 0;
              }
            })
            .reduce((a, b) => Math.max(a, b), known);
          lastSeq.set(code, newest);
        } catch {
          /* transient network error: retry next tick */
        }
      };
      pollers.set(
        code,
        setInterval(tick, POLL_MS)
      );
      tick();
    },

    unwatch(code) {
      const t = pollers.get(code);
      if (t) clearInterval(t);
      pollers.delete(code);
      lastSeq.delete(code);
    },

    /** New rooms start from "now" so we never replay ancient events. */
    async primeRoom(code) {
      if (!enabled) return;
      const seq = await currentSeq();
      lastSeq.set(code, seq);
    },
  };
}
