import type { CSSProperties } from 'react';
import type { Fixtures } from '../../../../shared/src/types.ts';
import type { ForestFrame, ForestSpread, SmokePuff } from './forest';

export function ForestLayers({
  id,
  map,
  spread,
  fire,
  future,
  smoke,
  time,
  showFire,
  showForecast,
  showSmoke,
}: {
  id: string;
  map: Fixtures['map'];
  spread: ForestSpread;
  fire: ForestFrame;
  future: ForestFrame;
  smoke: SmokePuff[];
  time: number;
  showFire: boolean;
  showForecast: boolean;
  showSmoke: boolean;
}) {
  const theta = ((map.wind.direction + 180) * Math.PI) / 180;
  const ux = Math.sin(theta),
    uy = -Math.cos(theta);
  const angle = (Math.atan2(uy, ux) * 180) / Math.PI;
  const smokeLabel = smoke[4];
  return (
    <>
      <defs>
        <clipPath id={`${id}-forest-clip`} clipPathUnits="userSpaceOnUse">
          <path d={spread.fuelPath} />
        </clipPath>
        <radialGradient id={`${id}-smoke-cloud`}>
          <stop stopColor="#4C4A44" stopOpacity=".95" />
          <stop offset=".5" stopColor="#A19E93" stopOpacity=".8" />
          <stop offset="1" stopColor="#A19E93" stopOpacity="0" />
        </radialGradient>
        <filter
          id={`${id}-smoke-wisp`}
          x="-20%"
          y="-40%"
          width="140%"
          height="180%"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency=".012"
            numOctaves="3"
            seed="8"
            result="billow"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="billow"
            scale="25"
            xChannelSelector="R"
            yChannelSelector="G"
          />
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      {showForecast && (
        <g
          data-testid="fire-forecast"
          aria-label="10분 후 연결된 숲의 예상 산불 범위"
          clipPath={`url(#${id}-forest-clip)`}
        >
          <path d={future.areaPath} fill="#FA4616" fillOpacity=".09" />
          <path
            d={future.boundaryPath}
            fill="none"
            stroke="#D9A700"
            strokeWidth="2"
            strokeDasharray="8 7"
            strokeLinejoin="round"
          />
        </g>
      )}
      {showFire && (
        <g
          data-testid="fire-layer"
          aria-label={`숲 내 모의 산불 확산 T+${time.toFixed(1)}분`}
        >
          <g
            data-testid="forest-fire-clip"
            clipPath={`url(#${id}-forest-clip)`}
          >
            <path
              data-testid="fire-perimeter"
              d={fire.areaPath}
              fill={`url(#${id}-burn)`}
              filter={`url(#${id}-fire-texture)`}
            />
            <path
              d={fire.boundaryPath}
              fill="none"
              stroke="#FA4616"
              strokeWidth="7"
              opacity=".6"
              filter={`url(#${id}-glow)`}
            />
            <path
              d={fire.boundaryPath}
              fill="none"
              stroke="#D9A700"
              strokeWidth="2"
              strokeLinejoin="round"
              opacity=".8"
            />
            {fire.flames.map((p, i) => (
              <g key={i} transform={`translate(${p.x} ${p.y})`}>
                <path
                  className="map-flame"
                  style={{ animationDelay: `${-i * 0.17}s` }}
                  d="M-4 5Q-8-1-3-6Q-3-1 0-11Q8-3 5 3Q2 9-4 5Z"
                  fill="#FA4616"
                />
                <path d="M-2 4Q-3 0 1-4Q5 4-2 4" fill="#D9A700" />
              </g>
            ))}
          </g>
          <circle
            cx={map.ignition.x}
            cy={map.ignition.y}
            r="8"
            fill="#FFF4D6"
            stroke="#8A0715"
            strokeWidth="4"
          />
          <text
            x={map.ignition.x + 15}
            y={map.ignition.y + 6}
            className="terrain-label fire-label"
            fontSize="13"
          >
            숲 발화점
          </text>
        </g>
      )}
      {showSmoke && smoke.length > 0 && (
        <g
          data-testid="smoke-layer"
          aria-label="바람을 따라 마을 쪽으로 흘러가는 모의 연기"
        >
          {[0, 1, 2].map((lane) => {
            const puffs = smoke.slice(lane * 14, (lane + 1) * 14);
            const upper = puffs.map(
              (p) => `${p.x - uy * p.ry * 0.85},${p.y + ux * p.ry * 0.85}`,
            );
            const lower = [...puffs]
              .reverse()
              .map(
                (p) => `${p.x + uy * p.ry * 0.85},${p.y - ux * p.ry * 0.85}`,
              );
            return (
              <path
                key={`wisp-${lane}`}
                d={`M${[...upper, ...lower].join('L')}Z`}
                fill="#4C4A44"
                opacity=".3"
                filter={`url(#${id}-smoke-wisp)`}
              />
            );
          })}
          {smoke.map((p, i) => (
            <g
              className="map-smoke"
              key={i}
              style={
                {
                  '--smoke-dx': `${ux * 80}px`,
                  '--smoke-dy': `${uy * 80}px`,
                  animationDelay: `${-i * 0.41}s`,
                } as CSSProperties
              }
            >
              <ellipse
                data-testid="smoke-puff"
                cx={p.x}
                cy={p.y}
                rx={p.rx}
                ry={p.ry}
                opacity={p.opacity}
                fill={`url(#${id}-smoke-cloud)`}
                transform={`rotate(${angle} ${p.x} ${p.y})`}
              />
            </g>
          ))}
          {smokeLabel && (
            <text
              x={Math.min(990, smokeLabel.x)}
              y={Math.min(700, Math.max(42, smokeLabel.y + 55))}
              className="terrain-label smoke-label"
              fontSize="12"
            >
              연기 → 마을 방향
            </text>
          )}
        </g>
      )}
    </>
  );
}
