"use client";

import { CameraControls, Line, Stars } from "@react-three/drei";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { labelOf, shortName } from "@/lib/agent/types";
import { sceneData, type Lane } from "@/lib/client/trace-state";
import { useTheme } from "@/lib/client/use-theme";
import { NODE_COLORS, nodeVar, type Theme } from "@/lib/theme";

export type ConstNode = { key: string; name: string; label: string; x: number; y: number; z: number; w: number };
export type Constellation = { nodes: ConstNode[]; edges: { a: string; b: string; t: string }[] };

/** Per-theme stage: dark relies on HDR colours and bloom; light uses flat, saturated colours on a pale sweep. */
const STAGE = {
  dark: { bg: "#05060a", fog: [700, 2000], gold: "#ffd166", baseEdge: "#5b6b8c", edge: "#6d5bd0", edgeActive: "#c4b5fd", pulse: "#e9d5ff" },
  light: { bg: "#eef1f7", fog: [900, 2400], gold: "#c99700", baseEdge: "#64748b", edge: "#a78bfa", edgeActive: "#6d28d9", pulse: "#5b21b6" },
} as const;

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}
function offset(key: string, radius: number) {
  const u = hash(key);
  const v = hash(key + "#");
  const theta = u * Math.PI * 2;
  const phi = Math.acos(2 * v - 1);
  const r = radius * (0.7 + 0.6 * hash(key + "r"));
  return new THREE.Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}
function repoOf(key: string): string | null {
  const m = /^(?:pr|issue|release):([^#@]+)/.exec(key) ?? /^(?:file|dir):([^:]+):/.exec(key);
  return m ? `repo:${m[1]}` : null;
}

/** Positions for every node in play: constellation nodes keep their stored layout; trace nodes settle near a neighbour. */
function resolvePositions(base: Map<string, THREE.Vector3>, keys: string[], edges: [string, string, string][]) {
  const pos = new Map(base);
  const pending = keys.filter((k) => !pos.has(k));
  for (let pass = 0; pass < 4 && pending.length; pass++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const k = pending[i];
      let anchor: THREE.Vector3 | undefined;
      for (const [a, , b] of edges) {
        const other = a === k ? b : b === k ? a : null;
        if (other && pos.has(other) && other !== k) {
          anchor = pos.get(other);
          break;
        }
      }
      if (!anchor && /^(file|dir):/.test(k)) {
        const [, repo, path] = /^(?:file|dir):([^:]+):(.*)$/.exec(k) ?? [];
        const parts = (path ?? "").split("/");
        for (let d = parts.length - 1; d > 0 && !anchor; d--) anchor = pos.get(`dir:${repo}:${parts.slice(0, d).join("/")}`);
      }
      if (!anchor && pass === 3) anchor = pos.get(repoOf(k) ?? "") ?? new THREE.Vector3();
      if (anchor) {
        pos.set(k, anchor.clone().add(offset(k, labelOf(k) === "Person" ? 34 : 24)));
        pending.splice(i, 1);
      }
    }
  }
  return pos;
}

const sphere = new THREE.SphereGeometry(1, 14, 14);
const tmp = new THREE.Object3D();
const col = new THREE.Color();

function baseSize(n: ConstNode) {
  if (n.label === "Repo") return 7;
  if (n.label === "Concept") return 1.8;
  if (n.label === "Person") return 1.1 + Math.min(2.2, Math.log10(1 + n.w) * 0.7);
  return 1.2 + Math.min(1.8, Math.log10(1 + n.w) * 0.6);
}

const bgCol = new THREE.Color();

/** Dark dims by darkening; light dims by fading toward the stage colour. */
function shade(c: THREE.Color, theme: Theme, darkScale: number, lightFade: number) {
  return theme === "dark" ? c.multiplyScalar(darkScale) : c.lerp(bgCol.set(STAGE.light.bg), lightFade);
}

function BaseNodes({ nodes, dim, theme }: { nodes: ConstNode[]; dim: boolean; theme: Theme }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const P = NODE_COLORS[theme];
    nodes.forEach((n, i) => {
      tmp.position.set(n.x, n.y, n.z);
      tmp.scale.setScalar(baseSize(n) * (dim ? (n.label === "Repo" ? 0.45 : 0.6) : 1));
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      const repo = n.label === "Repo";
      shade(col.set(P[n.label] ?? "#888"), theme, dim ? (repo ? 0.16 : 0.13) : repo ? 0.9 : 0.5, dim ? (repo ? 0.86 : 0.8) : repo ? 0.05 : 0.4);
      m.setColorAt(i, col);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [nodes, dim, theme]);
  return <instancedMesh ref={ref} args={[sphere, undefined, nodes.length]} frustumCulled={false}><meshBasicMaterial toneMapped={false} /></instancedMesh>;
}

function BaseEdges({ c, pos, dim, theme }: { c: Constellation; pos: Map<string, THREE.Vector3>; dim: boolean; theme: Theme }) {
  const geom = useMemo(() => {
    const arr: number[] = [];
    for (const e of c.edges) {
      const a = pos.get(e.a);
      const b = pos.get(e.b);
      if (a && b) arr.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    return g;
  }, [c, pos]);
  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial color={STAGE[theme].baseEdge} transparent opacity={theme === "dark" ? (dim ? 0.05 : 0.12) : dim ? 0.07 : 0.16} depthWrite={false} />
    </lineSegments>
  );
}

type TraceNode = { key: string; step: number; p: THREE.Vector3; label: string; active: boolean; gold: boolean };

function TraceNodes({ nodes, hovered, onHover, onPick, theme }: { nodes: TraceNode[]; hovered: string | null; onHover: (k: string | null) => void; onPick: (k: string) => void; theme: Theme }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const born = useRef(new Map<string, number>());
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const t = clock.elapsedTime;
    nodes.forEach((n, i) => {
      if (!born.current.has(n.key)) born.current.set(n.key, t);
      const age = t - born.current.get(n.key)!;
      const grow = Math.min(1, age / 0.5);
      const pop = 1 + Math.sin(Math.min(1, age / 0.6) * Math.PI) * 0.8;
      const base = n.label === "Repo" ? 7.5 : n.label === "Person" ? 3 : 2.4;
      const breathe = n.active ? 1 + Math.sin(t * 3 + i) * 0.08 : 1;
      const s = base * grow * pop * breathe * (hovered === n.key ? 1.6 : 1) * (n.gold && theme === "light" ? 1.25 : 1);
      tmp.position.copy(n.p);
      tmp.scale.setScalar(Math.max(0.001, s));
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      col.set(n.gold ? STAGE[theme].gold : NODE_COLORS[theme][n.label] ?? "#888");
      shade(col, theme, n.active || n.gold ? 2.6 : 1.25, n.active || n.gold ? 0 : 0.18);
      m.setColorAt(i, col);
    });
    m.count = nodes.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh
      ref={ref}
      args={[sphere, undefined, 600]}
      frustumCulled={false}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        if (e.instanceId !== undefined && nodes[e.instanceId]) onHover(nodes[e.instanceId].key);
      }}
      onPointerOut={() => onHover(null)}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        if (e.instanceId !== undefined && nodes[e.instanceId]) onPick(nodes[e.instanceId].key);
      }}
    >
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

function Pulse({ a, b, color, delay, gain }: { a: THREE.Vector3; b: THREE.Vector3; color: string; delay: number; gain: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const start = useRef<number | null>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    if (start.current === null) start.current = clock.elapsedTime + delay;
    const t = ((clock.elapsedTime - start.current) / 1.1) % 1;
    if (clock.elapsedTime < start.current) {
      ref.current.visible = false;
      return;
    }
    ref.current.visible = true;
    ref.current.position.lerpVectors(a, b, t < 0 ? 0 : t);
    ref.current.scale.setScalar(1.1 + Math.sin(t * Math.PI) * 0.9);
  });
  return (
    <mesh ref={ref} geometry={sphere}>
      <meshBasicMaterial color={new THREE.Color(color).multiplyScalar(gain)} toneMapped={false} />
    </mesh>
  );
}

function TraceEdges({ edges, pos, activeStep, theme }: { edges: ReturnType<typeof sceneData>["edges"]; pos: Map<string, THREE.Vector3>; activeStep: number; theme: Theme }) {
  const S = STAGE[theme];
  const dark = theme === "dark";
  return (
    <>
      {edges.slice(0, 220).map(({ e, step, gold }, i) => {
        const a = pos.get(e[0]);
        const b = pos.get(e[2]);
        if (!a || !b) return null;
        const active = step === activeStep;
        const color = gold ? S.gold : active ? S.edgeActive : S.edge;
        const gain = dark ? (gold ? 2.4 : active ? 1.8 : 0.9) : 1;
        return (
          <group key={`${e[0]}|${e[2]}|${gold}|${i}`}>
            <Line points={[a, b]} color={new THREE.Color(color).multiplyScalar(gain)} lineWidth={gold ? (dark ? 3 : 3.6) : active ? 1.8 : 1} transparent opacity={gold || active ? 1 : dark ? 0.55 : 0.7} toneMapped={false} />
            {(active || gold) && i < 160 && <Pulse a={a} b={b} color={gold ? (dark ? S.gold : "#9a7400") : S.pulse} gain={dark ? 4 : 1} delay={(i % 12) * 0.09} />}
          </group>
        );
      })}
    </>
  );
}

type LabelItem = { key: string; p: THREE.Vector3; label: string; text?: string; strong?: boolean; priority: number };

/** Projects label anchors to screen space every frame and hides labels that would overlap a higher-priority one. */
function LabelProjector({ items, refs }: { items: LabelItem[]; refs: React.RefObject<Map<string, HTMLDivElement>> }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const placed: [number, number, number, number][] = [];
    const sorted = [...items].sort((a, b) => b.priority - a.priority);
    for (const it of sorted) {
      const el = refs.current?.get(it.key);
      if (!el) continue;
      v.copy(it.p).project(camera);
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      const w = (it.text ?? shortName(it.key)).length * 6.4 + 12;
      const box: [number, number, number, number] = [x - w / 2, y - 26, x + w / 2, y - 8];
      const behind = v.z > 1 || x < -50 || x > size.width + 50 || y < -20 || y > size.height + 20;
      const hit = placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
      if (behind || hit) {
        el.style.opacity = "0";
        continue;
      }
      placed.push(box);
      el.style.opacity = "1";
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    }
  });
  return null;
}

function Rig({ focus, idle }: { focus: THREE.Sphere | null; idle: boolean }) {
  const ref = useRef<CameraControls>(null);
  const lastFocus = useRef<string>("");
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const sig = focus ? `${focus.center.x.toFixed(0)},${focus.center.y.toFixed(0)},${focus.center.z.toFixed(0)},${focus.radius.toFixed(0)}` : "all";
    if (sig === lastFocus.current) return;
    lastFocus.current = sig;
    if (focus) c.fitToSphere(new THREE.Sphere(focus.center, Math.max(focus.radius * 1.2, 55)), true);
    else c.setLookAt(0, 160, 720, 0, 0, 0, true);
  }, [focus]);
  useFrame((_, dt) => {
    if (ref.current && idle) ref.current.azimuthAngle += dt * 0.035;
  });
  return <CameraControls ref={ref} makeDefault smoothTime={0.6} minDistance={30} maxDistance={1600} />;
}

export function Scene({
  constellation,
  lane,
  upTo,
  hovered,
  onHover,
  onPick,
}: {
  constellation: Constellation | null;
  lane: Lane | null;
  upTo: number;
  hovered: string | null;
  onHover: (k: string | null) => void;
  onPick: (k: string) => void;
}) {
  const theme = useTheme();
  const S = STAGE[theme];
  const dark = theme === "dark";
  const c = constellation ?? { nodes: [], edges: [] };
  const base = useMemo(() => new Map(c.nodes.map((n) => [n.key, new THREE.Vector3(n.x, n.y, n.z)])), [c]);
  const data = useMemo(() => (lane ? sceneData(lane, upTo) : null), [lane, upTo]);
  const isVector = lane?.mode === "vector";
  const chunks = isVector ? (lane?.chunks ?? []) : [];

  const goldKeys = useMemo(() => new Set((lane?.citations ?? []).filter((x) => x.ok).flatMap((x) => [x.key, ...x.path.flatMap((e) => [e[0], e[2]])])), [lane]);
  const verifierShown = !!lane?.steps.slice(0, upTo).some((s) => s.agent === "verifier");

  const pos = useMemo(() => {
    const keys = [...(data?.nodes.keys() ?? []), ...chunks.map((ch) => ch.key)];
    return resolvePositions(base, keys, data?.edges.map((x) => x.e) ?? []);
  }, [base, data, chunks]);

  const traceNodes: TraceNode[] = useMemo(() => {
    if (!data) return [];
    const out: TraceNode[] = [];
    for (const [key, step] of data.nodes) {
      const p = pos.get(key);
      if (!p) continue;
      out.push({ key, step, p, label: labelOf(key), active: data.active.has(key), gold: verifierShown && goldKeys.has(key) });
    }
    return out.slice(0, 600);
  }, [data, pos, goldKeys, verifierShown]);

  const chunkPoints = useMemo(
    () => chunks.map((ch, i) => ({ key: ch.chunk ?? `${ch.key}:${i}`, owner: ch.key, score: ch.score, p: (pos.get(ch.key) ?? new THREE.Vector3()).clone().add(offset(`${ch.key}${i}`, 10)) })),
    [chunks, pos],
  );

  const focus = useMemo(() => {
    const pts = isVector ? chunkPoints.map((x) => x.p) : traceNodes.filter((n) => n.active || (verifierShown && n.gold)).map((n) => n.p);
    const use = pts.length ? pts : traceNodes.map((n) => n.p);
    if (!use.length) return null;
    return new THREE.Sphere().setFromPoints(use);
  }, [traceNodes, chunkPoints, isVector, verifierShown]);

  const labelItems = useMemo(() => {
    const items: LabelItem[] = [];
    const repos = c.nodes.filter((n) => n.label === "Repo");
    for (const r of repos) items.push({ key: r.key, p: new THREE.Vector3(r.x, r.y + 9, r.z), label: "Repo", text: r.name, priority: 1 });
    if (isVector) {
      chunkPoints.slice(0, 8).forEach((cp, i) => items.push({ key: cp.key, p: cp.p.clone().add(new THREE.Vector3(0, 3, 0)), label: "Chunk", text: `${shortName(cp.owner)} · ${cp.score.toFixed(2)}`, priority: 10 - i }));
    } else {
      const pick = traceNodes.filter((n) => n.label !== "Repo" && (n.active || (verifierShown && n.gold) || n.key === hovered)).slice(0, 24);
      for (const n of pick)
        items.push({ key: n.key, p: n.p.clone().add(new THREE.Vector3(0, 3.5, 0)), label: n.label, strong: n.gold && verifierShown, priority: n.key === hovered ? 100 : n.gold && verifierShown ? 50 : n.label === "Person" ? 20 : 10 });
    }
    return items;
  }, [c, traceNodes, chunkPoints, isVector, hovered, verifierShown]);
  const labelRefs = useRef(new Map<string, HTMLDivElement>());

  const idle = !lane || (lane.done && upTo >= lane.steps.length && !hovered);

  return (
    <div className="relative h-full w-full">
    <Canvas dpr={[1, 1.5]} camera={{ position: [0, 160, 720], fov: 45, near: 1, far: 5000 }} gl={{ antialias: true, powerPreference: "high-performance" }}>
      <color attach="background" args={[S.bg]} />
      <fog attach="fog" args={[S.bg, S.fog[0], S.fog[1]]} />
      {dark && <Stars radius={1400} depth={300} count={1600} factor={7} saturation={0} fade speed={0.25} />}
      <BaseNodes nodes={c.nodes} dim={!!lane && (traceNodes.length > 0 || chunkPoints.length > 0)} theme={theme} />
      <BaseEdges c={c} pos={base} dim={!!lane} theme={theme} />
      {data && !isVector && <TraceEdges edges={data.edges} pos={pos} activeStep={data.activeStep} theme={theme} />}
      {!isVector && <TraceNodes nodes={traceNodes} hovered={hovered} onHover={onHover} onPick={onPick} theme={theme} />}
      {isVector &&
        chunkPoints.map((cp) => (
          <mesh key={cp.key} position={cp.p} scale={1.4 + cp.score * 4} geometry={sphere} onClick={() => onPick(cp.owner)}>
            <meshBasicMaterial color={dark ? new THREE.Color(NODE_COLORS.dark.Chunk).multiplyScalar(1.4 + cp.score * 2) : NODE_COLORS.light.Chunk} toneMapped={false} />
          </mesh>
        ))}
      <LabelProjector items={labelItems} refs={labelRefs} />
      <Rig focus={focus} idle={idle} />
      {dark ? (
        <EffectComposer key="dark" multisampling={0}>
          <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.2} intensity={1.15} radius={0.7} />
          <Vignette eskil={false} offset={0.2} darkness={0.75} />
        </EffectComposer>
      ) : (
        <EffectComposer key="light" multisampling={4}>
          <Vignette eskil={false} offset={0.35} darkness={0.22} />
        </EffectComposer>
      )}
    </Canvas>
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {labelItems.map((it) => (
          <div
            key={it.key}
            ref={(el) => {
              if (el) labelRefs.current.set(it.key, el);
              else labelRefs.current.delete(it.key);
            }}
            className={`tl-label absolute left-0 top-0 ${it.strong ? "tl-label-strong" : ""}`}
            style={{ borderColor: nodeVar(it.label), opacity: 0 }}
          >
            {it.text ?? shortName(it.key)}
          </div>
        ))}
      </div>
    </div>
  );
}
