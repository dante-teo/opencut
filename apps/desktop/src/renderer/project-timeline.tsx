import type { Project, RationalTime } from '@opencut/core';

const seconds = (value: RationalTime) => value.numerator / value.denominator;
export const exactTime = (value: RationalTime) =>
  `${value.numerator}/${value.denominator} s`;
const clock = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`;

export function ProjectTimeline({
  project,
  selected,
  onSelect,
}: {
  project: Project | undefined;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const end =
    project?.clips.reduce(
      (maximum, clip) =>
        Math.max(
          maximum,
          seconds(clip.timelineStart) +
            seconds(clip.sourceOut) -
            seconds(clip.sourceIn),
        ),
      0,
    ) ?? 0;
  const span = Math.max(10, end * 1.1);
  return (
    <section className="timeline-panel" aria-label="Timeline">
      <div className="panel-heading timeline-heading">
        <h2>
          Timeline ({project?.tracks.length ?? 0} tracks ·{' '}
          {project?.clips.length ?? 0} clips)
        </h2>
        <span className="panel-hint">Read only · {end.toFixed(3)} s</span>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-row ruler-row">
          <div className="track-heading">TRACKS</div>
          <svg
            className="time-ruler"
            viewBox="0 0 1000 30"
            preserveAspectRatio="none"
            aria-label="Timeline ruler"
          >
            {Array.from({ length: 6 }, (_, index) => (
              <g key={index}>
                <line
                  x1={index * 195 + 1}
                  x2={index * 195 + 1}
                  y1="22"
                  y2="30"
                />
                <text
                  x={index === 5 ? 969 : index * 195 + 6}
                  textAnchor={index === 5 ? 'end' : 'start'}
                  y="15"
                >
                  {clock((index * span) / 5)}
                </text>
              </g>
            ))}
          </svg>
        </div>
        {!project?.tracks.length ? (
          <div className="timeline-empty">
            <span className="empty-symbol" aria-hidden="true">
              ▤
            </span>
            <p>No timeline tracks. Add tracks and clips through the CLI.</p>
          </div>
        ) : (
          project.tracks.map((track, index) => (
            <div className="timeline-row" key={track.id}>
              <div className="track-heading">
                <span className={`track-badge ${track.type}`}>
                  {track.type === 'video' ? 'V' : 'A'}
                  {index + 1}
                </span>
                <span>
                  <strong>{track.name}</strong>
                  <small>{track.type}</small>
                </span>
              </div>
              <svg
                className="track-lane"
                viewBox="0 0 1000 64"
                preserveAspectRatio="none"
                aria-label={`${track.name} clips`}
              >
                {!project.clips.some((clip) => clip.trackId === track.id) && (
                  <text className="empty-lane-label" x="20" y="37">
                    No clips on this track.
                  </text>
                )}
                {project.clips
                  .filter((clip) => clip.trackId === track.id)
                  .map((clip) => {
                    const x = (seconds(clip.timelineStart) / span) * 975;
                    const width = Math.max(
                      2,
                      ((seconds(clip.sourceOut) - seconds(clip.sourceIn)) /
                        span) *
                        975,
                    );
                    const asset = project.assets.find(
                      (asset) => asset.id === clip.assetId,
                    );
                    return (
                      <g
                        key={clip.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`Inspect clip ${clip.id}`}
                        aria-pressed={selected === clip.id}
                        className={`timeline-clip ${track.type}`}
                        onClick={() => onSelect(clip.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onSelect(clip.id);
                          }
                        }}
                      >
                        <title>
                          {clip.id} · {asset?.name} · Start{' '}
                          {exactTime(clip.timelineStart)} · Source{' '}
                          {exactTime(clip.sourceIn)} →{' '}
                          {exactTime(clip.sourceOut)}
                        </title>
                        <defs>
                          <clipPath id={`label-${clip.id}`}>
                            <rect
                              x={x + 1}
                              y="5"
                              width={Math.max(0, width - 2)}
                              height="54"
                            />
                          </clipPath>
                        </defs>
                        <rect x={x} y="5" width={width} height="54" rx="5" />
                        <g clipPath={`url(#label-${clip.id})`}>
                          <text x={x + 12} y="28">
                            {asset?.name ?? clip.assetId}
                          </text>
                          <text className="clip-id" x={x + 12} y="46">
                            {clip.id}
                          </text>
                        </g>
                      </g>
                    );
                  })}
              </svg>
            </div>
          ))
        )}
      </div>
      <div className="timeline-footer">
        Media and timeline are read only. Reopen the project after CLI edits to
        refresh this view.
      </div>
    </section>
  );
}
