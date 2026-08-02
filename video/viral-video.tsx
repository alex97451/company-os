import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type Accent = "gold" | "sky" | "rose" | "emerald";
type Transition = "cut" | "slide" | "zoom" | "wipe";
export type ViralScene = {
  id: string;
  startSeconds: number;
  durationSeconds: number;
  headline: string;
  body: string;
  narration: string;
  accent: Accent;
  transition: Transition;
};
export type ViralVideoProps = {
  title: string;
  language: "fr" | "en";
  durationSeconds: number;
  template: "problem_reveal_solution" | "quick_list" | "before_after";
  selectedHook: string;
  scenes: ViralScene[];
  audioDataUri: string;
};

const colors: Record<Accent, { main: string; glow: string }> = {
  gold: { main: "#f8d04d", glow: "rgba(248,208,77,.34)" },
  sky: { main: "#55c8ff", glow: "rgba(85,200,255,.32)" },
  rose: { main: "#ff6f91", glow: "rgba(255,111,145,.30)" },
  emerald: { main: "#46e6a8", glow: "rgba(70,230,168,.30)" },
};

export function ViralVideo(props: ViralVideoProps) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const progress = Math.min(1, frame / Math.max(1, durationInFrames - 1));
  return (
    <AbsoluteFill style={{ backgroundColor: "#070b13", color: "white", fontFamily: "Arial, Helvetica, sans-serif", overflow: "hidden" }}>
      <AmbientBackground frame={frame} />
      <div style={{ position: "absolute", top: 112, left: 82, right: 82, display: "flex", alignItems: "center", justifyContent: "space-between", zIndex: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 48, height: 48, border: "2px solid rgba(248,208,77,.65)", borderRadius: 14, display: "grid", placeItems: "center", color: "#f8d04d", fontSize: 26, fontWeight: 900 }}>✓</div>
          <span style={{ fontSize: 24, letterSpacing: 3, textTransform: "uppercase", color: "rgba(255,255,255,.72)", fontWeight: 700 }}>{props.title}</span>
        </div>
        <span style={{ fontSize: 22, color: "rgba(255,255,255,.46)" }}>{props.language === "fr" ? "À retenir" : "Worth knowing"}</span>
      </div>
      {props.scenes.map((scene) => (
        <Sequence key={scene.id} from={Math.round(scene.startSeconds * fps)} durationInFrames={Math.round(scene.durationSeconds * fps)} premountFor={fps}>
          <Scene scene={scene} template={props.template} />
        </Sequence>
      ))}
      {props.audioDataUri ? <Audio src={props.audioDataUri} volume={0.95} /> : null}
      <div style={{ position: "absolute", left: 82, right: 82, bottom: 104, height: 8, borderRadius: 999, background: "rgba(255,255,255,.12)", overflow: "hidden", zIndex: 8 }}>
        <div style={{ width: `${progress * 100}%`, height: "100%", background: "linear-gradient(90deg,#f8d04d,#55c8ff)", borderRadius: 999 }} />
      </div>
    </AbsoluteFill>
  );
}

function AmbientBackground({ frame }: { frame: number }) {
  const shift = interpolate(frame % 300, [0, 299], [-80, 80], { easing: Easing.inOut(Easing.sin) });
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", width: 720, height: 720, left: -260 + shift, top: 260, borderRadius: "50%", background: "radial-gradient(circle,rgba(85,200,255,.18),transparent 68%)", filter: "blur(16px)" }} />
      <div style={{ position: "absolute", width: 840, height: 840, right: -330 - shift, bottom: 110, borderRadius: "50%", background: "radial-gradient(circle,rgba(248,208,77,.18),transparent 70%)", filter: "blur(22px)" }} />
      <div style={{ position: "absolute", inset: 0, opacity: 0.18, backgroundImage: "linear-gradient(rgba(255,255,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.06) 1px,transparent 1px)", backgroundSize: "72px 72px" }} />
    </AbsoluteFill>
  );
}

function Scene({ scene, template }: { scene: ViralScene; template: ViralVideoProps["template"] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 115, mass: 0.8 } });
  const exit = interpolate(frame, [Math.max(0, scene.durationSeconds * fps - 12), scene.durationSeconds * fps], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const transition = scene.transition === "slide"
    ? { transform: `translateX(${(1 - enter) * 150}px)` }
    : scene.transition === "zoom"
      ? { transform: `scale(${0.78 + enter * 0.22})` }
      : scene.transition === "wipe"
        ? { clipPath: `inset(0 ${100 - enter * 100}% 0 0)` }
        : {};
  const palette = colors[scene.accent];
  const kicker = template === "quick_list" ? "POINT CLÉ" : template === "before_after" ? "AVANT / APRÈS" : "À SAVOIR";
  return (
    <AbsoluteFill style={{ padding: "250px 82px 330px", justifyContent: "center", opacity: exit, ...transition }}>
      <div style={{ display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 14, marginBottom: 34, padding: "12px 20px", borderRadius: 999, background: palette.glow, color: palette.main, fontSize: 22, fontWeight: 900, letterSpacing: 3 }}>
        <span style={{ width: 10, height: 10, borderRadius: 99, background: palette.main, boxShadow: `0 0 24px ${palette.main}` }} />{kicker}
      </div>
      <h1 style={{ margin: 0, maxWidth: 920, fontSize: scene.headline.length > 55 ? 76 : 96, lineHeight: 0.98, letterSpacing: -4, fontWeight: 900, textWrap: "balance" }}>{scene.headline}</h1>
      {scene.body ? <p style={{ margin: "38px 0 0", maxWidth: 880, color: "rgba(255,255,255,.74)", fontSize: scene.body.length > 130 ? 38 : 46, lineHeight: 1.22, fontWeight: 600, textWrap: "balance" }}>{scene.body}</p> : null}
      <div style={{ position: "absolute", left: 82, right: 82, bottom: 190, padding: "22px 28px", borderRadius: 24, background: "rgba(7,11,19,.82)", border: "1px solid rgba(255,255,255,.14)", boxShadow: "0 18px 60px rgba(0,0,0,.35)", fontSize: 34, lineHeight: 1.25, fontWeight: 750, textAlign: "center" }}>
        {scene.narration}
      </div>
    </AbsoluteFill>
  );
}
