import { useState } from 'react';
import { deliveryTargets, dialoguePresetControls } from '@opencut/core';
import type {
  AudioRole,
  DeliveryPreset,
  ProfessionalMix,
  VideoMixEdit,
} from '@opencut/core/video';
import type { DefinitionReview } from '../bridge.js';

const fallback: ProfessionalMix = {
  preset: 'natural-cinematic',
  enabled: false,
};
const format = (value: number | null, unit: string) =>
  value === null ? 'Unmeasurable' : `${value.toFixed(1)} ${unit}`;

export function DialogueMix({
  revision,
  disabled,
}: {
  revision: NonNullable<DefinitionReview['current']>;
  disabled: boolean;
}) {
  const { project, audioMix, generation } = revision;
  const projectRoles = Object.fromEntries(
    project.tracks.flatMap(({ id, audioRole }) =>
      audioRole ? [[id, audioRole] as const] : [],
    ),
  );
  const [mix, setMix] = useState(project.professionalMix ?? fallback);
  const [roles, setRoles] = useState(projectRoles);
  const [advanced, setAdvanced] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    message: string;
    error?: boolean;
  }>();
  const [pending, setPending] = useState(false);
  const busy = disabled || pending;
  const defaults = dialoguePresetControls[mix.preset];
  const output = mix.delivery?.preset ?? 'web';
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const audioTracks = project.tracks.filter(
    (track) =>
      track.type === 'audio' ||
      project.clips.some(
        (clip) =>
          clip.trackId === track.id &&
          clip.assetId &&
          assets.get(clip.assetId)?.mediaTypes.includes('audio'),
      ),
  );

  function change(values: Partial<ProfessionalMix>) {
    setMix({ ...mix, ...values });
    setAdvanced(null);
  }

  async function run(action: () => Promise<string | void>) {
    setPending(true);
    setFeedback(undefined);
    try {
      const message = await action();
      if (message) setFeedback({ message });
    } catch (error) {
      setFeedback({
        error: true,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  }

  function edit(): VideoMixEdit {
    return {
      roles,
      mix: advanced === null ? mix : (JSON.parse(advanced) as ProfessionalMix),
    };
  }

  function compare(comparison: 'before' | 'after') {
    void run(() => window.opencut.compareDialogueMix(generation, comparison));
  }

  async function reset() {
    await window.opencut.applyDialogueMix(generation, null);
    setMix(project.professionalMix ?? fallback);
    setRoles(projectRoles);
    setAdvanced(null);
  }

  function setRole(id: string, role: AudioRole) {
    setRoles({ ...roles, [id]: role });
    if (role === 'dialogue') return;
    // Clear reference and curve overrides for clips routed away from dialogue.
    const ids = new Set(
      project.clips
        .filter((clip) => clip.trackId === id)
        .map((clip) => clip.id),
    );
    const matching = mix.matching;
    const automation = mix.automation;
    const source = automation?.dialogue;
    change({
      matching:
        matching?.referenceClip && ids.has(matching.referenceClip)
          ? { amount: matching.amount }
          : matching,
      automation: source
        ? {
            ...automation,
            dialogue: Object.fromEntries(
              Object.entries(source).filter(([clip]) => !ids.has(clip)),
            ),
          }
        : automation,
    });
  }

  const sliders = [
    ['cleanup', 'Voice Cleanup'],
    ['clarity', 'Voice Clarity'],
    ['warmth', 'Voice Warmth'],
    ['consistency', 'Volume Consistency'],
  ] as const;
  return (
    <section className="dialogue-mix-panel" aria-label="Dialogue mix settings">
      <fieldset disabled={busy}>
        <div className="dialogue-mix-grid">
          <label>
            <input
              type="checkbox"
              checked={mix.enabled !== false}
              onChange={(event) =>
                change({ enabled: event.currentTarget.checked })
              }
            />{' '}
            Enable mix
          </label>
          <label>
            Preset
            <select
              value={mix.preset}
              onChange={(event) => {
                setMix({
                  preset: event.currentTarget
                    .value as ProfessionalMix['preset'],
                  enabled: mix.enabled,
                  delivery: mix.delivery,
                });
                setAdvanced(null);
              }}
            >
              <option value="natural-cinematic">
                Natural Cinematic Dialogue
              </option>
              <option value="clear-voiceover">
                Clear Professional Voiceover
              </option>
            </select>
          </label>
          {sliders.map(([key, title]) => (
            <label key={key}>
              {title}
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={mix[key] ?? defaults[key]}
                onChange={(event) =>
                  change({ [key]: event.currentTarget.valueAsNumber })
                }
              />
            </label>
          ))}
          <label>
            Music Ducking{' '}
            <span>{mix.ducking?.depthDb ?? defaults.duckingDepth} dB</span>
            <input
              type="range"
              min="0"
              max="36"
              step="1"
              value={mix.ducking?.depthDb ?? defaults.duckingDepth}
              onChange={(event) =>
                change({
                  ducking: {
                    ...mix.ducking,
                    depthDb: event.currentTarget.valueAsNumber,
                  },
                })
              }
            />
          </label>
          <label>
            Output Loudness
            <select
              value={output}
              onChange={(event) =>
                change({
                  delivery: {
                    preset: event.currentTarget.value as DeliveryPreset,
                  },
                })
              }
            >
              {(Object.keys(deliveryTargets) as DeliveryPreset[]).map(
                (preset) => (
                  <option key={preset} value={preset}>
                    {preset[0]!.toUpperCase() + preset.slice(1)} ·{' '}
                    {deliveryTargets[preset].integratedLufs} LUFS
                  </option>
                ),
              )}
            </select>
          </label>
        </div>
        {audioTracks.length > 0 && (
          <div className="dialogue-mix-grid" aria-label="Audio routing">
            {audioTracks.map((track) => (
              <label key={track.id}>
                {track.name}
                <select
                  aria-label={`${track.name} audio role`}
                  value={roles[track.id] ?? 'other'}
                  onChange={(event) =>
                    setRole(track.id, event.currentTarget.value as AudioRole)
                  }
                >
                  <option value="other">Other</option>
                  <option value="dialogue">Dialogue</option>
                  <option value="music">Music</option>
                </select>
              </label>
            ))}
          </div>
        )}
        <details className="dialogue-mix-advanced">
          <summary>Advanced settings and automation</summary>
          <label>
            <input
              type="checkbox"
              checked={mix.ai === 'deepfilternet'}
              onChange={(event) =>
                change({
                  ai: event.currentTarget.checked ? 'deepfilternet' : undefined,
                })
              }
            />{' '}
            DeepFilterNet
          </label>
          <textarea
            aria-label="Advanced mix settings"
            spellCheck={false}
            value={advanced ?? JSON.stringify(mix, null, 2)}
            onChange={(event) => setAdvanced(event.currentTarget.value)}
          />
          {audioMix && (
            <button onClick={() => change({ automation: audioMix.automation })}>
              Use analyzed curves
            </button>
          )}
        </details>
        <div className="dialogue-mix-actions">
          <button
            onClick={() =>
              void run(() =>
                window.opencut.applyDialogueMix(generation, edit()),
              )
            }
          >
            Apply to preview
          </button>
          {audioMix && audioMix.comparison === 'after' && (
            <button onClick={() => compare('before')}>Compare before</button>
          )}
          {audioMix?.comparison === 'before' && (
            <button onClick={() => compare('after')}>Compare after</button>
          )}
          <button onClick={() => void run(reset)}>Reset to definition</button>
          <button
            onClick={() =>
              void run(async () => {
                const saved = await window.opencut.saveDialogueMix(edit());
                if (saved) return `Saved ${saved}`;
              })
            }
          >
            Save mix settings
          </button>
          <button
            onClick={() =>
              void run(async () => {
                const loaded = await window.opencut.loadDialogueMix();
                if (loaded) {
                  setRoles(loaded.roles ?? projectRoles);
                  setMix(loaded.mix ?? fallback);
                  setAdvanced(null);
                }
              })
            }
          >
            Load mix settings
          </button>
        </div>
      </fieldset>
      {audioMix && (
        <div>
          <output aria-label="Mix loudness">
            {audioMix.comparison === 'before'
              ? 'Before (level matched)'
              : 'After'}{' '}
            · {format(audioMix.output.integratedLufs, 'LUFS')} ·{' '}
            {format(audioMix.output.truePeakDbtp, 'dBTP')} ·{' '}
            {audioMix.output.loudnessRange.toFixed(1)} LU range
          </output>
          {audioMix.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
      {feedback && (
        <p role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>
      )}
    </section>
  );
}
