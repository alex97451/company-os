import { Composition } from "remotion";
import { ViralVideo, type ViralVideoProps } from "./viral-video";

const defaultProps: ViralVideoProps = {
  title: "Company OS",
  language: "fr",
  durationSeconds: 15,
  template: "problem_reveal_solution",
  selectedHook: "Une idée claire en quinze secondes.",
  scenes: [
    { id: "scene_1", startSeconds: 0, durationSeconds: 5, headline: "Le problème", body: "Une information confuse fait perdre l’attention.", narration: "Une information confuse fait perdre l’attention.", accent: "rose", transition: "zoom" },
    { id: "scene_2", startSeconds: 5, durationSeconds: 5, headline: "La révélation", body: "Une idée, un rythme, une preuve.", narration: "Gardez une idée, un rythme et une preuve.", accent: "sky", transition: "slide" },
    { id: "scene_3", startSeconds: 10, durationSeconds: 5, headline: "Passez à l’action", body: "Regardez la version complète.", narration: "Regardez maintenant la version complète.", accent: "gold", transition: "wipe" },
  ],
  audioDataUri: "",
};

export function VideoRoot() {
  return (
    <Composition
      id="FacelessVerticalV1"
      component={ViralVideo}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={450}
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => ({ durationInFrames: Math.round(props.durationSeconds * 30) })}
    />
  );
}
