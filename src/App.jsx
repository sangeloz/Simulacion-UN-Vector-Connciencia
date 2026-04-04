import { useState, useEffect, useRef, useCallback } from "react";

const CW = 360, CH = 360, BVL = 60, MAX_REACH = 110, MAX_RES_LEN = 105, SUM_MAX = 2.14, TRAIL_LEN = 70;

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  bg:         "#060d18",
  bgPanel:    "rgba(6, 14, 26, 0.96)",
  border:     "rgba(0, 200, 175, 0.18)",
  borderHi:   "rgba(0, 200, 175, 0.45)",
  borderDim:  "rgba(0, 200, 175, 0.08)",
  textPri:    "#d4ede8",
  textSec:    "rgba(0, 210, 185, 0.70)",
  textDim:    "rgba(0, 210, 185, 0.32)",
  cyan:       "#00d8c8",
  cyanGlow:   "#00ffe5",
  resultant:  "#00d8ff",
  green:      "#00e676",
  red:        "#ff4d6d",
  mono:       "'Courier New', 'Lucida Console', monospace",
};

const DRIVES = [
  { id: "ic",  uc: true,  ba: 38,  bm: 0.68, af: 0,    aa: 0,  mf: 0,    ma: 0,    ph: 0   },
  { id: "mie", label: "MIEDO",          color: "#ff4d6d", uc: false, ba: 200, bm: 0.38, af: 0.28, aa: 40, mf: 0.35, ma: 0.22, ph: 1.2 },
  { id: "des", label: "DESEO",          color: "#f5a040", uc: false, ba: 75,  bm: 0.44, af: 0.14, aa: 24, mf: 0.22, ma: 0.18, ph: 0.7 },
  { id: "soc", label: "IMPULSO SOCIAL", color: "#00e676", uc: false, ba: 308, bm: 0.28, af: 0.52, aa: 50, mf: 0.42, ma: 0.20, ph: 2.1 },
  { id: "hab", label: "HÁBITO",         color: "#b44fff", uc: false, ba: 150, bm: 0.36, af: 0.07, aa: 18, mf: 0.09, ma: 0.14, ph: 3.5 },
];

// ─── Field function — accepts a slow time offset ──────────────────────────────
// t evolves at ~0.04 units/sec → full variation cycle ≈ 25 seconds
function fv(nx, ny, t = 0) {
  const a = Math.sin(nx * Math.PI * 2.2 + 0.4 + t * 0.31) * Math.cos(ny * Math.PI * 1.8 + 0.5 + t * 0.17);
  const b = Math.cos(nx * Math.PI * 1.5 + 1.1 + t * 0.23) * Math.sin(ny * Math.PI * 2.4 + 0.7 + t * 0.19);
  const c = Math.sin((nx * 1.9 + ny * 1.4) * Math.PI + 0.8 + t * 0.13);
  return Math.max(0, Math.min(1, (a * 0.4 + b * 0.35 + c * 0.25 + 1) / 2));
}

// fv used for physics always reads the current field time
let _fieldT = 0;
function fvCurrent(nx, ny) { return fv(nx, ny, _fieldT); }

function buildTexture(t = 0) {
  const d = new Uint8ClampedArray(CW * CH * 4);
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const v = fv(x / CW, y / CH, t);
      let r, g, b;
      if (v < 0.38) {
        const tt = v / 0.38;
        r = Math.round(6  + tt * 22); g = Math.round(4  + tt * 8); b = Math.round(28 + tt * 38);
      } else if (v < 0.63) {
        const tt = (v - 0.38) / 0.25;
        r = Math.round(28 - tt * 20); g = Math.round(12 + tt * 60); b = Math.round(66 + tt * 24);
      } else {
        const tt = (v - 0.63) / 0.37;
        r = Math.round(8  - tt * 8); g = Math.round(72 + tt * 148); b = Math.round(90 + tt * 118);
      }
      const i = (y * CW + x) * 4;
      d[i] = r; d[i+1] = g; d[i+2] = b; d[i+3] = 255;
    }
  }
  return new ImageData(d, CW, CH);
}

function drawGrid(ctx) {
  ctx.save();
  ctx.strokeStyle = "rgba(0, 200, 175, 0.07)";
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= CW; x += 36) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CH); ctx.stroke(); }
  for (let y = 0; y <= CH; y += 36) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CW, y); ctx.stroke(); }
  ctx.restore();
}

function getDrive(d, elapsed, angle, vol, noise) {
  if (d.uc) return { angle, mag: vol, id: d.id, uc: true };
  const a = d.ba + d.aa * noise * Math.sin(d.af * elapsed * 2 * Math.PI + d.ph);
  const m = Math.max(0.03, Math.min(0.95, d.bm + d.ma * noise * Math.sin(d.mf * elapsed * 2 * Math.PI + d.ph + 1)));
  return { angle: a, mag: m, color: d.color, id: d.id, uc: false };
}

function computeResult(elapsed, angle, vol, noise) {
  let rx = 0, ry = 0, sumMag = 0;
  const vecs = DRIVES.map(d => getDrive(d, elapsed, angle, vol, noise));
  vecs.forEach(v => {
    const r = v.angle * Math.PI / 180;
    rx += Math.cos(r) * v.mag; ry += Math.sin(r) * v.mag; sumMag += v.mag;
  });
  const mag = Math.sqrt(rx * rx + ry * ry);
  const rAngle = Math.atan2(ry, rx);
  const coherence = (Math.cos(rAngle - angle * Math.PI / 180) + 1) / 2;
  return { mag, angle: rAngle, alignment: sumMag > 0 ? mag / sumMag : 0, normMag: mag / SUM_MAX, coherence, vecs };
}

function drawArrow(ctx, x1, y1, x2, y2, color, lw, alpha) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy);
  if (len < 2) return;
  ctx.globalAlpha = alpha;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke();
  if (len > 10) {
    const r = Math.atan2(dy, dx), hl = Math.min(9, len * 0.36), ha = Math.PI / 6.5;
    ctx.beginPath();
    ctx.moveTo(x2, y2); ctx.lineTo(x2 - hl * Math.cos(r - ha), y2 - hl * Math.sin(r - ha));
    ctx.moveTo(x2, y2); ctx.lineTo(x2 - hl * Math.cos(r + ha), y2 - hl * Math.sin(r + ha));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function cohLabel(c) {
  if (c >= 0.88) return "plena";
  if (c >= 0.70) return "alta";
  if (c >= 0.50) return "media";
  if (c >= 0.30) return "baja";
  return "opuesta";
}

function interpText(fp, ali, coup, noise, coh) {
  if (noise < 0.12) return "Ruido interno en mínimo: los vectores inconscientes son estáticos. Ves la configuración base de tu conciencia — la posición por defecto antes de cualquier agitación interna.";
  if (coh < 0.25)   return "La intención apunta en dirección opuesta al resultante. Los impulsos inconscientes dominan la trayectoria real. Hay mucha energía — pero en sentido contrario a lo que conscientemente se quiere.";
  if (ali < 0.28)   return "Los vectores internos se dispersan en direcciones contrarias. El resultante oscila sin rumbo — no por falta de energía, sino por incoherencia. El campo no puede amplificar lo que no encuentra forma.";
  if (ali >= 0.65 && fp >= 0.63 && coup >= 0.60) return "Convergencia máxima: vectores alineados, campo activo y acoplamiento profundo. El resultante es largo, estable y coherente. Esta es la geometría de la acción eficaz en el MVC.";
  if (coh >= 0.85 && ali >= 0.55) return "Alta coherencia I→R: la intención consciente y el resultante apuntan juntos. Los vectores inconscientes amplifican la dirección elegida.";
  if (ali >= 0.55 && fp < 0.40)   return "Alta coherencia interna, pero el campo atenúa la proyección. Moverse hacia una zona cian multiplicaría un vector ya bien formado.";
  if (coup < 0.15)  return "Acoplamiento mínimo: la conciencia aún no ha construido historia con este campo. Aunque el resultante sea coherente, su proyección al mundo es todavía provisional.";
  return "El campo evoluciona lentamente — las zonas de potencia y atenuación se desplazan. Permanecer quieto no es permanecer en el mismo campo.";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SliderRow({ label, value, min, max, displayValue, onChange }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, letterSpacing: "0.09em", color: T.textSec, marginBottom: 6 }}>
        <span>{label}</span>
        <span style={{ fontFamily: T.mono, color: T.cyan }}>{displayValue}</span>
      </div>
      <input type="range" min={min} max={max} value={value} step="1" onChange={e => onChange(+e.target.value)}
        style={{
          WebkitAppearance: "none", appearance: "none", width: "100%", height: 3,
          background: `linear-gradient(to right, ${T.cyan} 0%, ${T.cyan} ${pct}%, rgba(0,200,175,0.15) ${pct}%, rgba(0,200,175,0.15) 100%)`,
          borderRadius: 2, cursor: "pointer", outline: "none", margin: 0,
        }} />
    </div>
  );
}

function MetricRow({ label, value, valueColor, highlight }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "4px 0",
      borderBottom: highlight ? "none" : `0.5px solid ${T.borderDim}`,
      borderTop: highlight ? `0.5px solid ${T.border}` : "none",
      marginTop: highlight ? 4 : 0,
    }}>
      <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: "0.07em", color: highlight ? T.textSec : T.textDim }}>{label}</span>
      <span style={{ fontSize: highlight ? 14 : 12, fontWeight: 500, fontFamily: T.mono, color: valueColor || (highlight ? T.cyanGlow : T.textPri) }}>
        {value}
      </span>
    </div>
  );
}

function LegendRow({ label, color, pct }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
      <div style={{ width: 7, height: 7, borderRadius: "50%", background: color, boxShadow: `0 0 5px ${color}99`, flexShrink: 0 }} />
      <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: "0.06em", color: T.textSec, flex: 1 }}>{label}</span>
      <div style={{ flex: "0 0 40px", height: 2, background: "rgba(0,200,175,0.10)", borderRadius: 1, overflow: "hidden" }}>
        <div style={{ height: "100%", borderRadius: 1, background: color, width: `${Math.round(pct)}%`, transition: "width 0.15s", boxShadow: `0 0 3px ${color}` }} />
      </div>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 3, padding: "0.75rem 0.9rem" }}>
      {title && <p style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.16em", color: T.textDim, margin: "0 0 9px" }}>{title}</p>}
      {children}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

// Field animation constants
const FADE_DURATION = 3.5;    // seconds for cross-fade between textures
const REBUILD_EVERY = 4.0;    // seconds between texture rebuilds
// FIELD_SPEED is now a ref — controlled by the user slider (0.005 … 0.18)

export default function MVCVectorInterno() {
  const canvasRef    = useRef(null);
  const offARef      = useRef(null);  // current texture
  const offBRef      = useRef(null);  // incoming texture
  const stateRef     = useRef({ nx: 0.38, ny: 0.32, coup: 0.22, elapsed: 0, trail: [], lastTS: 0 });

  // Field animation state (in ref to avoid re-render overhead)
  const fieldRef = useRef({
    t:          0,       // current field time
    tB:         REBUILD_EVERY * 0.038, // target field time for next texture
    fadeAlpha:  0,       // 0 = fully A, 1 = fully B
    fadingIn:   false,   // currently cross-fading?
    timeSinceRebuild: 0, // seconds since last rebuild
  });

  const frameRef     = useRef(0);
  const dragRef      = useRef(false);
  const angleRef     = useRef(38);
  const volRef       = useRef(0.68);
  const noiseRef     = useRef(0.5);
  const pausedRef    = useRef(false);

  const [angle,      setAngle]      = useState(38);
  const [vol,        setVol]        = useState(68);
  const [noise,      setNoise]      = useState(50);
  const [paused,     setPaused]     = useState(false);
  const [fieldSpeed, setFieldSpeed] = useState(38); // slider 0–100 → mapped to 0.005–0.18
  const fieldSpeedRef = useRef(0.038);
  const [metrics, setMetrics] = useState({
    zona: "—", fp: "—", ali: "—", coh: "—", cohVal: 0.5,
    coup: "—", eff: "—", interp: "—", drives: [], resNorm: 0, fp_val: 0.5,
  });

  useEffect(() => { angleRef.current     = angle;                                }, [angle]);
  useEffect(() => { volRef.current       = vol / 100;                            }, [vol]);
  useEffect(() => { noiseRef.current     = noise / 100;                          }, [noise]);
  useEffect(() => { pausedRef.current    = paused;                               }, [paused]);
  useEffect(() => { fieldSpeedRef.current = 0.005 + (fieldSpeed / 100) * 0.175; }, [fieldSpeed]);

  // Build initial textures
  useEffect(() => {
    const makeOff = (t) => {
      const c = document.createElement("canvas");
      c.width = CW; c.height = CH;
      c.getContext("2d").putImageData(buildTexture(t), 0, 0);
      return c;
    };
    offARef.current = makeOff(0);
    offBRef.current = makeOff(fieldRef.current.tB);
  }, []);

  // Animation loop
  useEffect(() => {
    let rafId;

    function tick(ts) {
      const S  = stateRef.current;
      const F  = fieldRef.current;
      const dt = Math.min(0.05, (ts - (S.lastTS || ts)) / 1000);
      S.lastTS = ts;

      const isPaused = pausedRef.current;
      const a = angleRef.current, v = volRef.current, n = noiseRef.current;

      if (!isPaused) {
        S.elapsed += dt;

        // ── Field time evolution ──────────────────────────────────────
        F.t += fieldSpeedRef.current * dt;
        _fieldT = F.t;

        F.timeSinceRebuild += dt;

        // Start a new cross-fade when it's time
        if (!F.fadingIn && F.timeSinceRebuild >= REBUILD_EVERY) {
          F.fadingIn = true;
          F.fadeAlpha = 0;
          F.tB = F.t + REBUILD_EVERY * fieldSpeedRef.current;
          // Build new target texture asynchronously via setTimeout to avoid frame drop
          const tTarget = F.tB;
          setTimeout(() => {
            if (!offBRef.current) offBRef.current = document.createElement("canvas");
            offBRef.current.width = CW; offBRef.current.height = CH;
            offBRef.current.getContext("2d").putImageData(buildTexture(tTarget), 0, 0);
          }, 0);
        }

        // Advance cross-fade
        if (F.fadingIn) {
          F.fadeAlpha = Math.min(1, F.fadeAlpha + dt / FADE_DURATION);
          if (F.fadeAlpha >= 1) {
            // Swap: B becomes A
            const tmp = offARef.current;
            offARef.current = offBRef.current;
            offBRef.current = tmp;
            F.fadingIn = false;
            F.fadeAlpha = 0;
            F.timeSinceRebuild = 0;
          }
        }

        // Coupling
        const fp = fvCurrent(S.nx, S.ny);
        S.coup = Math.max(0.04, Math.min(1.0, S.coup + (fp > 0.56 ? 0.055 : fp < 0.44 ? -0.032 : (fp - 0.5) * 0.06) * dt));
      }

      const canvas = canvasRef.current;
      if (!canvas || !offARef.current) { rafId = requestAnimationFrame(tick); return; }
      const ctx = canvas.getContext("2d");

      const fp  = fvCurrent(S.nx, S.ny);
      const res = computeResult(S.elapsed, a, v, n);
      const px  = S.nx * CW, py = S.ny * CH;
      const resLen = Math.max(12, Math.min(MAX_RES_LEN, res.mag * BVL * 0.72));
      const reachR = Math.max(6, res.normMag * fp * S.coup * MAX_REACH);
      const rTX = px + Math.cos(res.angle) * resLen;
      const rTY = py + Math.sin(res.angle) * resLen;

      if (!isPaused) {
        S.trail.push({ dx: rTX - px, dy: rTY - py });
        if (S.trail.length > TRAIL_LEN) S.trail.shift();
      }

      // ── Draw field (cross-fade A → B) ─────────────────────────────
      ctx.globalAlpha = 1;
      ctx.drawImage(offARef.current, 0, 0);
      if (F.fadingIn && offBRef.current && F.fadeAlpha > 0) {
        ctx.globalAlpha = F.fadeAlpha;
        ctx.drawImage(offBRef.current, 0, 0);
        ctx.globalAlpha = 1;
      }

      drawGrid(ctx);
      if (isPaused) { ctx.fillStyle = "rgba(0,0,0,0.20)"; ctx.fillRect(0, 0, CW, CH); }

      // ── Reach circle ──────────────────────────────────────────────
      const isCyan = fp > 0.55;
      ctx.beginPath(); ctx.arc(px, py, reachR, 0, Math.PI * 2);
      ctx.fillStyle = isCyan
        ? `rgba(0,220,190,${(0.04 + S.coup * 0.09).toFixed(3)})`
        : `rgba(100,50,220,${(0.04 + S.coup * 0.07).toFixed(3)})`;
      ctx.fill();
      ctx.strokeStyle = isCyan
        ? `rgba(0,230,200,${(0.16 + S.coup * 0.44).toFixed(3)})`
        : `rgba(140,70,255,${(0.10 + S.coup * 0.36).toFixed(3)})`;
      ctx.lineWidth = 1.5; ctx.setLineDash([4, 5]); ctx.stroke(); ctx.setLineDash([]);

      // ── Unconscious vectors ───────────────────────────────────────
      res.vecs.forEach(v2 => {
        if (v2.uc) return;
        const r = v2.angle * Math.PI / 180;
        drawArrow(ctx, px, py, px + Math.cos(r) * v2.mag * BVL, py + Math.sin(r) * v2.mag * BVL, v2.color, 1.4, 0.72);
      });

      // ── Trail ─────────────────────────────────────────────────────
      S.trail.forEach((pt, i) => {
        const alpha = (i / S.trail.length) * 0.60;
        const sz    = 1.0 + (i / S.trail.length) * 2.0;
        ctx.beginPath(); ctx.arc(px + pt.dx, py + pt.dy, sz, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,216,255,${alpha.toFixed(3)})`; ctx.fill();
      });

      // ── Resultant ─────────────────────────────────────────────────
      ctx.shadowColor = T.resultant; ctx.shadowBlur = 16;
      drawArrow(ctx, px, py, rTX, rTY, T.resultant, 3.5, 1);
      ctx.beginPath(); ctx.arc(rTX, rTY, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = T.resultant; ctx.fill();
      ctx.shadowBlur = 0;

      // ── Deviation arc I→R ─────────────────────────────────────────
      const icRad = a * Math.PI / 180;
      let aDiff = Math.abs(res.angle - icRad) % (Math.PI * 2);
      if (aDiff > Math.PI) aDiff = Math.PI * 2 - aDiff;
      if (aDiff > 0.08) {
        let aS = icRad, aE = res.angle;
        const diff = ((aE - aS) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        if (diff > Math.PI) { const tmp = aS; aS = aE; aE = tmp + Math.PI * 2; }
        ctx.beginPath(); ctx.arc(px, py, 22, aS, aE);
        ctx.strokeStyle = "rgba(255,255,255,0.24)"; ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([]);
      }

      // ── Node ──────────────────────────────────────────────────────
      const gr = ctx.createRadialGradient(px, py, 0, px, py, 24);
      gr.addColorStop(0, `rgba(0,220,200,${(0.12 + S.coup * 0.10).toFixed(3)})`);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      ctx.beginPath(); ctx.arc(px, py, 24, 0, Math.PI * 2); ctx.fillStyle = gr; ctx.fill();

      ctx.beginPath(); ctx.arc(px, py, 14, -Math.PI / 2, -Math.PI / 2 + S.coup * Math.PI * 2);
      ctx.strokeStyle = isCyan
        ? `rgba(0,255,180,${(0.5 + S.coup * 0.5).toFixed(3)})`
        : `rgba(180,80,255,${(0.4 + S.coup * 0.5).toFixed(3)})`;
      ctx.lineWidth = 2.5; ctx.stroke();

      ctx.shadowColor = "rgba(180,255,240,0.8)"; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(px, py, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = "#d8fff5"; ctx.fill();
      ctx.shadowBlur = 0;

      // ── Labels ────────────────────────────────────────────────────
      if (isPaused) {
        ctx.save(); ctx.font = `bold 10px ${T.mono}`; ctx.fillStyle = "rgba(0,220,190,0.45)";
        ctx.textAlign = "right"; ctx.fillText("— PAUSADO —", CW - 8, CH - 8); ctx.restore();
      }
      ctx.save();
      ctx.font = `9px ${T.mono}`; ctx.fillStyle = "rgba(0,200,170,0.26)";
      ctx.textAlign = "center"; ctx.fillText("↑ trascendencia", CW / 2, 13);
      ctx.fillText("↓ materia", CW / 2, CH - 6);
      ctx.textAlign = "left";  ctx.fillText("← origen", 5, CH / 2 + 4);
      ctx.textAlign = "right"; ctx.fillText("otro →", CW - 5, CH / 2 + 4);
      ctx.restore();

      // ── Metrics (every 6 frames) ──────────────────────────────────
      frameRef.current++;
      if (frameRef.current % 6 === 0) {
        const eff = res.normMag * fp * S.coup;
        setMetrics({
          zona:    fp >= 0.63 ? "ALTA POTENCIA" : fp >= 0.44 ? "ZONA MEDIA" : "ZONA ATENUADA",
          fp:      Math.round(fp * 100) + "%",
          ali:     Math.round(res.alignment * 100) + "%",
          coh:     `${Math.round(res.coherence * 100)}% — ${cohLabel(res.coherence)}`,
          cohVal:  res.coherence,
          coup:    Math.round(S.coup * 100) + "%",
          eff:     Math.round(eff * 100) + "%",
          interp:  interpText(fp, res.alignment, S.coup, n, res.coherence),
          drives:  res.vecs.filter(v2 => !v2.uc).map(v2 => ({ id: v2.id, mag: v2.mag })),
          resNorm: res.normMag,
          fp_val:  fp,
        });
      }

      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // ─── Drag handlers ────────────────────────────────────────────────────────
  const getXY = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      nx: Math.max(0.02, Math.min(0.98, (cx - rect.left) / rect.width)),
      ny: Math.max(0.02, Math.min(0.98, (cy - rect.top)  / rect.height)),
    };
  }, []);
  const onMouseDown = useCallback((e) => {
    const S = stateRef.current, p = getXY(e);
    if (Math.hypot(p.nx - S.nx, p.ny - S.ny) * CW < 28) { dragRef.current = true; S.trail = []; }
  }, [getXY]);
  const onMouseMove = useCallback((e) => {
    if (!dragRef.current) return;
    const p = getXY(e); stateRef.current.nx = p.nx; stateRef.current.ny = p.ny;
  }, [getXY]);
  const onMouseUp = useCallback(() => { dragRef.current = false; }, []);

  // ─── Derived ──────────────────────────────────────────────────────────────
  const cohColor     = metrics.cohVal >= 0.70 ? T.green : metrics.cohVal <= 0.40 ? T.red : T.textPri;
  const accentBorder = metrics.fp_val >= 0.63 ? "rgba(0,230,180,0.55)" : metrics.fp_val >= 0.44 ? T.border : "rgba(140,80,255,0.55)";
  const driveMap     = Object.fromEntries(metrics.drives.map(d => [d.id, d.mag]));
  const unconscious  = DRIVES.filter(d => !d.uc);
  const btnBase      = { fontFamily: T.mono, letterSpacing: "0.10em", fontSize: 10, cursor: "pointer", borderRadius: 3, background: "transparent" };

  return (
    <div style={{ background: T.bg, padding: "1.2rem", display: "flex", flexDirection: "column", gap: 12 }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <h1 style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 400, letterSpacing: "0.22em", color: T.cyan, margin: 0 }}>
            VECTORES DE LA CONCIENCIA
          </h1>
          <p style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: "0.08em", fontStyle: "italic", color: T.textDim, margin: "5px 0 0" }}>
            ¿el campo modula la conciencia — o la conciencia construye el campo?
          </p>
        </div>
        <button
          onClick={() => setPaused(p => !p)}
          style={{ ...btnBase, border: `1px solid ${paused ? T.cyan : T.border}`, color: paused ? T.cyanGlow : T.textSec, padding: "6px 14px" }}
        >
          {paused ? "► REANUDAR" : "⏸ PAUSAR"}
        </button>
      </div>

      {/* Canvas + side panels */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ borderRadius: 3, overflow: "hidden", border: `1px solid ${T.border}`, flexShrink: 0, maxWidth: "100%", boxShadow: "0 0 28px rgba(0,200,175,0.07)" }}>
          <canvas ref={canvasRef} width={CW} height={CH}
            style={{ display: "block", cursor: "crosshair", touchAction: "none", maxWidth: "100%" }}
            onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
            onTouchStart={onMouseDown} onTouchMove={onMouseMove} onTouchEnd={onMouseUp}
          />
        </div>

        <div style={{ flex: "1 1 185px", minWidth: 185, maxWidth: 245, display: "flex", flexDirection: "column", gap: 8 }}>
          <Panel title="FUERZA · ACOPLAMIENTO · PRESIÓN">
            <MetricRow label="ZONA"             value={metrics.zona} />
            <MetricRow label="POTENCIA CAMPO"   value={metrics.fp} />
            <MetricRow label="ALINEACIÓN"       value={metrics.ali} />
            <MetricRow label="COHERENCIA I→R"   value={metrics.coh} valueColor={cohColor} />
            <MetricRow label="ACOPLAMIENTO"     value={metrics.coup} />
            <MetricRow label="ALCANCE EFECTIVO" value={metrics.eff} highlight />
          </Panel>

          <Panel title="INTENCIÓN CONSCIENTE">
            <SliderRow label="DIRECCIÓN" min={0}   max={359} value={angle} displayValue={`${angle}°`} onChange={setAngle} />
            <SliderRow label="VOLUNTAD"  min={5}   max={100} value={vol}   displayValue={`${vol}%`}   onChange={setVol} />
            <SliderRow label="RUIDO INT" min={0}   max={100} value={noise} displayValue={`${noise}%`} onChange={setNoise} />
            <button
              onClick={() => { stateRef.current.coup = 0.04; }}
              style={{ ...btnBase, border: `1px solid ${T.border}`, color: T.textSec, padding: "6px", width: "100%", marginTop: 7 }}
            >
              ↺ REINICIAR ACOPLAMIENTO
            </button>
          </Panel>

          <Panel title="CAMPO POTENCIAL EXISTENCIAL">
            <SliderRow
              label="VELOCIDAD DEL CAMPO"
              min={0} max={100} value={fieldSpeed}
              displayValue={fieldSpeed < 15 ? "lento" : fieldSpeed < 50 ? "normal" : fieldSpeed < 80 ? "rápido" : "máximo"}
              onChange={setFieldSpeed}
            />
            <p style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.05em", color: T.textDim, margin: "4px 0 0", lineHeight: 1.6 }}>
              el campo evoluciona independientemente de los agentes que lo habitan
            </p>
          </Panel>

          <Panel title="VECTORES INCONSCIENTES">
            {unconscious.map(d => (
              <LegendRow key={d.id} label={d.label} color={d.color} pct={(driveMap[d.id] ?? d.bm) * 100} />
            ))}
            <div style={{ marginTop: 8, paddingTop: 6, borderTop: `0.5px solid ${T.borderDim}`, display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 10, height: 2, background: T.resultant, borderRadius: 1, boxShadow: `0 0 5px ${T.resultant}`, flexShrink: 0 }} />
              <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: "0.08em", color: T.textSec, flex: 1 }}>RESULTANTE</span>
              <div style={{ flex: "0 0 40px", height: 2, background: "rgba(0,200,175,0.10)", borderRadius: 1, overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 1, background: T.resultant, width: `${Math.round(Math.min(1, metrics.resNorm) * 100)}%`, transition: "width 0.15s", boxShadow: `0 0 4px ${T.resultant}` }} />
              </div>
            </div>
          </Panel>
        </div>
      </div>

      {/* Interpretation */}
      <div style={{
        fontFamily: T.mono, fontSize: 11, fontStyle: "italic", lineHeight: 1.85,
        color: T.textSec, borderLeft: `2px solid ${accentBorder}`,
        padding: "0.6rem 0.9rem", background: "rgba(0,200,175,0.03)", borderRadius: "0 3px 3px 0",
      }}>
        {metrics.interp || "—"}
      </div>

      <p style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.06em", color: T.textDim, lineHeight: 1.7, margin: 0 }}>
        vectores de color = impulsos inconscientes · cian = resultante · arrastra el nodo para cambiar la zona del campo · el campo evoluciona lentamente
      </p>
    </div>
  );
}