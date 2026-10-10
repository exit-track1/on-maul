import type { Fixtures } from '../../../../shared/src/types.ts';
import type { ForestFrame, ForestSpread } from './forest';

export function ForestLayers({
  id,
  map,
  spread,
  fire,
  future,
  time,
  showFire,
  showForecast,
}: {
  id: string;
  map: Fixtures['map'];
  spread: ForestSpread;
  fire: ForestFrame;
  future: ForestFrame;
  time: number;
  showFire: boolean;
  showForecast: boolean;
}) {
  return (
    <>
      <defs>
        <clipPath id={`${id}-forest-clip`} clipPathUnits="userSpaceOnUse">
          <path d={spread.fuelPath} />
        </clipPath>
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
    </>
  );
}
