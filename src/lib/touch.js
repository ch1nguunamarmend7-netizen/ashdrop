// "Touch to send": the phone feels a gentle touch against the computer through its motion sensor.
// Nothing here talks to the network; it only turns sensor readings into one "touched" event.
//
// Tuned on a real iPhone (see /lab/touch). A touch is ONE short jolt:
//   - sideways or along the phone (x or y): touching the laptop with the phone's edge.
//     Putting the phone down flat jolts it along z, so that does not count.
//   - between 2.3 and 16 m/s² (gravity removed): a soft knock, not a drop on the desk
//   - the phone was not swinging around just before (walking, waving), and is still right after
//   - no second jolt within half a second either side (handling the phone makes several)

export const motionSupported = () => typeof window !== 'undefined' && typeof DeviceMotionEvent !== 'undefined';

/** iPhone asks once per visit; call this from a tap. Resolves true when readings are allowed. */
export async function askMotion() {
  if (!motionSupported()) return false;
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    try { return (await DeviceMotionEvent.requestPermission()) === 'granted'; } catch { return false; }
  }
  return true;
}

export const RULE = { min: 2.3, max: 16, before: 1.5, after: 0.9, alone: 500, ring: 150 };

/** Start listening. onTouch({ peak, axis }) fires for each touch. Returns stop(). */
export function watchTouch(onTouch, rule = RULE) {
  const hist = []; // { t, m }
  let g = null, pending = null, last = null;
  const avg = (from, to) => { const s = hist.filter((h) => h.t > from && h.t < to); return s.length ? s.reduce((a, h) => a + h.m, 0) / s.length : 0; };
  const decide = (now) => {
    if (!pending || now - pending.t < rule.alone + 20) return;
    const p = pending; pending = null;
    if (p.crowded) return;
    const after = avg(p.t + 150, p.t + 500);
    if (p.ax !== 'z' && p.m >= rule.min && p.m <= rule.max && p.before < rule.before && after < rule.after) onTouch({ peak: p.m, axis: p.ax });
  };
  const onMotion = (e) => {
    const t = performance.now();
    let x, y, z;
    if (e.acceleration && e.acceleration.x != null) ({ x, y, z } = e.acceleration);
    else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x != null) {
      const a = e.accelerationIncludingGravity; g = g ? { x: g.x * 0.9 + a.x * 0.1, y: g.y * 0.9 + a.y * 0.1, z: g.z * 0.9 + a.z * 0.1 } : { ...a };
      x = a.x - g.x; y = a.y - g.y; z = a.z - g.z;
    } else return;
    const m = Math.hypot(x, y, z);
    const ax = Math.abs(x) >= Math.abs(y) && Math.abs(x) >= Math.abs(z) ? 'x' : Math.abs(y) >= Math.abs(z) ? 'y' : 'z';
    hist.push({ t, m }); while (hist.length && hist[0].t < t - 2000) hist.shift();
    if (pending && t - pending.t < rule.ring && m > pending.m) { pending.m = m; pending.ax = ax; } // the same jolt still ringing
    else if (m >= rule.min && (!last || t - last > rule.ring)) {
      const crowded = !!last && t - last < rule.alone; // another jolt just before: handling, not a touch
      if (pending) pending.crowded = true;           // ...and this one spoils the one before it too
      pending = { t, m, ax, before: avg(t - 450, t - 80), crowded };
      last = t;
    }
    decide(t);
  };
  window.addEventListener('devicemotion', onMotion);
  const tick = setInterval(() => decide(performance.now()), 100);
  return () => { window.removeEventListener('devicemotion', onMotion); clearInterval(tick); };
}
