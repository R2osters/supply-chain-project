// src/scenes/Placeholder.tsx — stand-in for a scene not built yet, so the whole film renders end to end with the HUD
// and the wipes: the scene background and a charter card with the scene id, title and section.
import {AbsoluteFill} from 'remotion';
import {sceneDef, type SceneId} from '../lib/timeline';
import {palette} from '../theme/tokens';
import {Card} from '../components/Card';
import {Chip} from '../components/Chip';
import {CONDENSED, SANS} from '../components/typography';

export const Placeholder: React.FC<{id: SceneId}> = ({id}) => {
  const scene = sceneDef(id);
  const pal = palette(scene.theme);
  return (
    <AbsoluteFill style={{background: pal.bg, alignItems: 'center', justifyContent: 'center'}}>
      <Card theme={scene.theme} width={880} height={400} radius={14} shadow="md" style={{padding: 48, display: 'flex', flexDirection: 'column', justifyContent: 'space-between'}}>
        <Chip theme={scene.theme} style={{alignSelf: 'flex-start'}}>{scene.section}</Chip>
        <div>
          <div style={{fontFamily: CONDENSED, fontWeight: 600, fontSize: 150, lineHeight: 1, letterSpacing: '-0.02em', color: pal.ink}}>{scene.id}</div>
          <div style={{fontFamily: SANS, fontWeight: 500, fontSize: 44, lineHeight: 1.2, marginTop: 16, color: pal.muted}}>{scene.title}</div>
        </div>
      </Card>
    </AbsoluteFill>
  );
};
