import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from 'react';
import { Btn, Card, Pill } from '../index';
import {
  GROUP_LABELS,
  groupOf,
  nextAction,
  STATUS_LABELS,
} from '../../../../shared/src/domain.ts';
import type { PanelProps } from '../../tabs/Panels';
import type { Point } from '../../../../shared/src/types.ts';
import { predictionEvidence } from '../../../../shared/src/monitoring.ts';
import {
  MAP_COLORS,
  mapMotions,
  clusterMotions,
  routeHeading,
  motionLabelOffsets,
  pathPoints,
  type MapMotion,
} from './model';
import './map.css';
import {
  forestPropagation,
  forestFrame,
  smokePlume,
  forestZoneLabel,
} from './forest';
import { ForestLayers } from './ForestLayers';

type Layer = 'people' | 'vehicles' | 'fire' | 'forecast' | 'smoke';
const layerNames: Record<Layer, string> = {
  people: '주민 이동',
  vehicles: '차량 이동',
  fire: '산불 확산',
  forecast: '10분 후',
  smoke: '연기 흐름',
};

function Person({ color = '#FA4616' }: { color?: string }) {
  return (
    <g className="person-symbol" stroke="#4C4A44" strokeWidth="1.5">
      <ellipse
        cx="1"
        cy="12"
        rx="10"
        ry="4"
        fill="#4C4A44"
        opacity=".35"
        stroke="none"
      />
      <path
        className="person-legs"
        d="M-3 2l-4 10M3 2l5 10"
        fill="none"
        stroke={color}
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path d="M-5-8Q0-12 5-8L4 3h-8Z" fill={color} />
      <path
        className="person-arms"
        d="M-5-6l-6 7M5-6l6 4"
        stroke={color}
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <circle cy="-15" r="4.5" fill="#f1d5b6" />
    </g>
  );
}

function Vehicle({ ambulance, held }: { ambulance?: boolean; held?: boolean }) {
  return (
    <g>
      <ellipse cy="5" rx="25" ry="14" fill="#4C4A44" opacity=".35" />
      <rect x="-18" y="-12" width="8" height="6" rx="2" fill="#4C4A44" />
      <rect x="-18" y="7" width="8" height="6" rx="2" fill="#4C4A44" />
      <rect x="9" y="-12" width="8" height="6" rx="2" fill="#4C4A44" />
      <rect x="9" y="7" width="8" height="6" rx="2" fill="#4C4A44" />
      <rect
        x="-22"
        y="-10"
        width="44"
        height="20"
        rx="5"
        fill={held ? '#FA4616' : ambulance ? '#FFF4D6' : '#D9A700'}
        stroke="#FFF4D6"
        strokeWidth="1.5"
      />
      <rect x="8" y="-8" width="7" height="16" rx="2" fill="#4C4A44" />
      <path d="M-15-8h18v16h-18" fill={ambulance ? '#FFF4D6' : '#D9A700'} />
      <path
        d="M-20-8v16"
        stroke={ambulance ? '#8A0715' : '#FFF4D6'}
        strokeWidth="3"
      />
      <path d="M20-7v3M20 4v3" stroke="#D9A700" strokeWidth="2" />
      {ambulance && (
        <>
          <path d="M-7-4v8M-11 0h8" stroke="#8A0715" strokeWidth="2.5" />
          <rect
            className="vehicle-beacon"
            x="4"
            y="-7"
            width="3"
            height="5"
            fill="#8A0715"
          />
          <rect x="4" y="2" width="3" height="5" fill="#FA4616" />
        </>
      )}
    </g>
  );
}

function MotionMarker({
  motion,
  labelOffset,
  select,
  featured,
}: {
  motion: MapMotion;
  labelOffset: { x: number; y: number };
  select: (id: string) => void;
  featured?: boolean;
}) {
  const { position, kind } = motion;
  const labelY = labelOffset.y;
  return (
    <g
      data-testid={
        motion.tripId
          ? 'trip-vehicle'
          : kind === 'person'
            ? 'moving-person'
            : 'moving-vehicle'
      }
      className={`motion-marker ${motion.held ? 'motion-held' : ''}`}
      transform={`translate(${position.x} ${position.y})`}
      aria-label={
        motion.tripId
          ? `${motion.id} ${motion.householdId} ${motion.held ? '보류' : motion.stage}`
          : `${motion.label} · 모의 경로 위치`
      }
      onClick={() => select(motion.householdId)}
    >
      <title>
        {motion.label} · {motion.held ? '임무 보류' : '이동 경로 시각화'} · 실제
        GPS 위치 아님
      </title>
      <circle
        r={kind === 'person' ? 18 : 28}
        fill={
          motion.held ? '#8A0715' : kind === 'person' ? '#FA4616' : '#D9A700'
        }
        fillOpacity=".18"
        stroke={
          motion.held ? '#8A0715' : kind === 'person' ? '#FA4616' : '#D9A700'
        }
        strokeOpacity=".8"
      />
      {kind === 'person' ? (
        <g>
          {(motion.members?.length ?? 0) > 1 || (motion.passengers ?? 0) > 1 ? (
            <>
              <g transform="translate(-5 -3)">
                <Person color="#FA4616" />
              </g>
              <g transform="translate(6 3)">
                <Person />
              </g>
            </>
          ) : (
            <Person />
          )}
        </g>
      ) : (
        <g
          transform={`rotate(${routeHeading(motion.route, motion.position)})`}
          data-testid={featured ? 'demo-vehicle' : undefined}
          data-x={position.x}
          data-y={position.y}
        >
          <Vehicle ambulance={motion.ambulance} held={motion.held} />
        </g>
      )}
      <path
        d={`M0 ${labelY < 0 ? -20 : 18}L${labelOffset.x} ${labelY < 0 ? labelY + 7 : labelY - 13}`}
        stroke={kind === 'person' ? '#FA4616' : '#D9A700'}
        strokeWidth="1"
      />
      <rect
        x="-34"
        y={labelY - 13}
        width="68"
        height="20"
        rx="5"
        fill="#4C4A44"
        fillOpacity=".95"
        stroke={kind === 'person' ? '#FA4616' : '#D9A700'}
        strokeWidth="1"
      />
      <text
        y={labelY + 1}
        textAnchor="middle"
        fontSize="11"
        fill="#fff"
        fontWeight="650"
      >
        {(motion.members?.length ?? 0) > 1
          ? `${motion.members!.length}가구 이동`
          : motion.id}
        {motion.passengers && motion.passengers > 1
          ? ` · ${motion.passengers}명`
          : ''}
      </text>
    </g>
  );
}

export function MapPanel({
  view,
  open,
  run,
  focusRequest,
  featuredResidentId,
  featuredStory,
  plannedPosition,
}: PanelProps & {
  focusRequest?: { id: string; sequence: number; fit?: boolean };
  featuredResidentId?: string;
  featuredStory?: 'grandfather' | 'squad';
  plannedPosition?: Point;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<Layer, boolean>>({
    people: true,
    vehicles: true,
    fire: true,
    forecast: true,
    smoke: true,
  });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(30);
  const [preview, setPreview] = useState(0);
  const [frameOffset, setFrameOffset] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState({ x: 600, y: 380 });
  const [expanded, setExpanded] = useState(false);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(
    null,
  );
  const id = useId().replace(/:/g, '');
  const {
    map,
    zones,
    households: authoritativeHouseholds,
    shelters,
    teams,
  } = view.data;
  const households = useMemo(
    () =>
      plannedPosition
        ? authoritativeHouseholds.map((household) =>
            household.id === featuredResidentId
              ? {
                  ...household,
                  demoPosition: plannedPosition,
                  name:
                    featuredStory === 'grandfather'
                      ? '반영환 할아버지'
                      : '박미숙 할머니',
                }
              : household,
          )
        : authoritativeHouseholds,
    [
      authoritativeHouseholds,
      plannedPosition,
      featuredResidentId,
      featuredStory,
    ],
  );
  const active =
    view.scenario.mode === 'event' || view.scenario.mode === 'record';
  const windEvidence = predictionEvidence(view);
  const spreadAvailable =
    active && (Boolean(view.showcase) || windEvidence.usable);
  const c = view.scenario.counts;
  const cycle = Boolean(view.simulation.cycleId);
  const demoResidentId = view.demonstration?.residentId ?? featuredResidentId;
  const demoVehicleId = view.demonstration?.vehicleId;
  const renderOffset = cycle ? frameOffset : preview;
  const time = view.simMinutes + renderOffset;
  const motions = useMemo(
    () => (active ? mapMotions(view, renderOffset) : []),
    [active, view, renderOffset],
  );
  const people = motions.filter((m) => m.kind === 'person');
  const vehicles = motions.filter((m) => m.kind === 'vehicle');
  const forest = useMemo(
    () => forestPropagation(map, plannedPosition ? [plannedPosition] : []),
    [
      map.ignition.x,
      map.ignition.y,
      map.wind.direction,
      map.wind.speedMps,
      map.metersPerPixel,
      plannedPosition?.x,
      plannedPosition?.y,
    ],
  );
  const fire = useMemo(() => forestFrame(forest, time), [forest, time]);
  const future = useMemo(() => forestFrame(forest, time + 10), [forest, time]);
  const smoke = useMemo(
    () => smokePlume(map, fire, time),
    [map.wind.direction, map.wind.speedMps, fire, time],
  );
  const visibleMotions = motions.filter(
    (m) => layers[m.kind === 'person' ? 'people' : 'vehicles'],
  );
  const displayMotions = clusterMotions(visibleMotions, 38 / zoom);
  const labelOffsets = motionLabelOffsets(displayMotions);
  const household = households.find((h) => h.id === selected);
  const status =
    household &&
    view.scenario.householdStatuses.find((s) => s.householdId === household.id);
  const theta = ((map.wind.direction + 180) * Math.PI) / 180;
  const width = 1200 / zoom,
    height = 760 / zoom;
  const clampCenter = (x: number, y: number) => ({
    x: Math.max(width / 2, Math.min(1200 - width / 2, x)),
    y: Math.max(height / 2, Math.min(760 - height / 2, y)),
  });

  useEffect(() => {
    setPreview(0);
    setPlaying(false);
    setSelected(null);
  }, [view.scenario.id]);
  useEffect(() => {
    if (!focusRequest) return;
    const home = households.find((h) => h.id === focusRequest.id);
    if (!home) return;
    setSelected(home.id);
    if (focusRequest.fit) {
      // The cycle overview keeps the house, vehicle origin and shelters in one
      // viewport. Explicit house requests below retain the close view.
      setZoom(1);
      setCenter({ x: 600, y: 380 });
      return;
    }
    setZoom(2);
    setCenter({
      x: Math.max(300, Math.min(900, home.demoPosition.x)),
      y: Math.max(190, Math.min(570, home.demoPosition.y)),
    });
  }, [focusRequest]);
  useEffect(() => {
    if (!cycle) {
      setPreview(0);
      setPlaying(false);
    }
  }, [cycle, view.simMinutes]);
  useEffect(() => {
    if (cycle || !playing || !active || view.frozen) return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const delta = (Math.min(now - last, 250) / 60000) * speed;
      last = now;
      setPreview((t) => Math.min(15, t + delta));
    }, 80);
    return () => window.clearInterval(timer);
  }, [playing, speed, active, view.frozen, cycle]);
  useEffect(() => {
    setFrameOffset(0);
    if (
      !cycle ||
      !view.simulation.playing ||
      view.simulation.phase !== 'running' ||
      view.frozen ||
      view.networkDown
    )
      return;
    const receivedAt = performance.now();
    let frame = 0;
    let lastFrame = 0;
    const interpolate = (now: number) => {
      if (now - lastFrame >= 1000 / 30) {
        lastFrame = now;
        // Rendering only: never extrapolate more than a single polling window,
        // change a trip stage, or create an admission/reservation in the UI.
        setFrameOffset(
          (Math.min(250, Math.max(0, now - receivedAt)) / 60000) *
            view.simulation.speed,
        );
      }
      frame = requestAnimationFrame(interpolate);
    };
    frame = requestAnimationFrame(interpolate);
    return () => cancelAnimationFrame(frame);
  }, [cycle, view]);
  useEffect(() => {
    if (preview >= 15) setPlaying(false);
  }, [preview]);
  useEffect(() => {
    if (!expanded) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [expanded]);

  const startDrag = (e: PointerEvent<SVGSVGElement>) => {
    if (
      zoom <= 1 ||
      (e.target as Element).closest('[role="button"], .motion-marker')
    )
      return;
    drag.current = { x: e.clientX, y: e.clientY, cx: center.x, cy: center.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const box = e.currentTarget.getBoundingClientRect();
    setCenter(
      clampCenter(
        drag.current.cx - ((e.clientX - drag.current.x) * width) / box.width,
        drag.current.cy - ((e.clientY - drag.current.y) * height) / box.height,
      ),
    );
  };

  return (
    <div className={`evacuation-map ${expanded ? 'map-expanded' : ''}`}>
      <div className="panel-title map-panel-title">
        <div>
          <h2>마을 대피 지도</h2>
          <p>
            {plannedPosition
              ? '집 강조는 합성 시연 예정 위치입니다. 시작 후 같은 위치에서 구조를 진행합니다.'
              : '지형 위에서 주민의 이동과 대응 상황을 확인합니다.'}
          </p>
        </div>
        <Pill tone="soft">합성 마을 · 48가구</Pill>
      </div>
      <div className="map-layer-bar" aria-label="지도 레이어">
        <span className="map-layer-caption">
          <span className="layer-icon">◫</span> 표시 레이어
        </span>
        {(Object.keys(layerNames) as Layer[]).map((layer) => (
          <button
            key={layer}
            aria-pressed={layers[layer]}
            onClick={() => setLayers({ ...layers, [layer]: !layers[layer] })}
          >
            <span className={`layer-dot layer-${layer}`} />
            {layerNames[layer]}
          </button>
        ))}
        <button
          className="map-expand-button"
          aria-label={expanded ? '지도 크게 보기 닫기' : '지도 크게 보기'}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '↙ 접기' : '⤢ 크게 보기'}
        </button>
      </div>
      <div
        className={`map-wrap terrain-map ${(cycle ? view.simulation.playing : playing) && !view.frozen ? 'is-playing' : 'is-paused'}`}
      >
        <svg
          className={`map ${zoom > 1 ? 'map-draggable' : ''}`}
          viewBox={`${center.x - width / 2} ${center.y - height / 2} ${width} ${height}`}
          aria-label={`48가구, ${map.roads.length}개 도로, 3개 대피소와 주민·차량 이동 및 산불 확산의 합성 지도`}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <defs>
            <linearGradient id={`${id}-river`} x2="0" y2="1">
              <stop stopColor="#799694" />
              <stop offset=".5" stopColor="#456f7c" />
              <stop offset="1" stopColor="#86adb1" />
            </linearGradient>
            <linearGradient id={`${id}-roof`} x2="0" y2="1">
              <stop stopColor="#c5c0aa" />
              <stop offset=".48" stopColor="#b9b7a7" />
              <stop offset=".51" stopColor="#8e938a" />
              <stop offset="1" stopColor="#777d77" />
            </linearGradient>
            <radialGradient id={`${id}-burn`}>
              <stop stopColor="#2c2117" stopOpacity=".88" />
              <stop offset=".65" stopColor="#6c3522" stopOpacity=".72" />
              <stop offset="1" stopColor="#d96331" stopOpacity=".30" />
            </radialGradient>
            <filter
              id={`${id}-fire-texture`}
              x="-10%"
              y="-10%"
              width="120%"
              height="120%"
            >
              <feTurbulence
                type="fractalNoise"
                baseFrequency=".05"
                numOctaves="3"
                seed="12"
                result="noise"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="noise"
                scale="10"
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
            <filter
              id={`${id}-glow`}
              x="-100%"
              y="-100%"
              width="300%"
              height="300%"
            >
              <feGaussianBlur stdDeviation="3" />
            </filter>
          </defs>
          <image
            href={`${import.meta.env.BASE_URL}map/village-terrain.webp`}
            width="1200"
            height="760"
            preserveAspectRatio="none"
          />
          <rect
            width="1200"
            height="760"
            fill="#183023"
            opacity=".1"
            pointerEvents="none"
          />
          <g className="map-river">
            <polyline
              points={map.river.map((p) => p.join(',')).join(' ')}
              fill="none"
              stroke="#b3ad84"
              strokeWidth="31"
              strokeLinejoin="round"
            />
            <polyline
              points={map.river.map((p) => p.join(',')).join(' ')}
              fill="none"
              stroke="#596c55"
              strokeWidth="25"
              strokeLinejoin="round"
            />
            <polyline
              points={map.river.map((p) => p.join(',')).join(' ')}
              fill="none"
              stroke={`url(#${id}-river)`}
              strokeWidth="20"
              strokeLinejoin="round"
            />
            <polyline
              points={map.river.map((p) => p.join(',')).join(' ')}
              fill="none"
              stroke="#b3d0c5"
              strokeOpacity=".35"
              strokeWidth="1.5"
              transform="translate(0 -4)"
            />
          </g>
          {map.roads.map((road) => (
            <g key={road.id}>
              <polyline
                points={road.points.map((p) => p.join(',')).join(' ')}
                fill="none"
                stroke="#25382b"
                strokeOpacity=".4"
                strokeWidth="16"
                strokeLinejoin="round"
                transform="translate(2 3)"
              />
              <polyline
                points={road.points.map((p) => p.join(',')).join(' ')}
                fill="none"
                stroke="#bcbbaa"
                strokeWidth="12"
                strokeLinejoin="round"
              />
              <polyline
                points={road.points.map((p) => p.join(',')).join(' ')}
                fill="none"
                stroke="#858c80"
                strokeWidth="8"
                strokeLinejoin="round"
              />
              <polyline
                points={road.points.map((p) => p.join(',')).join(' ')}
                fill="none"
                stroke={road.blocked ? '#ed8b63' : '#ddd6b9'}
                strokeWidth={road.blocked ? '3' : '1'}
                strokeDasharray={road.blocked ? '7 6' : '7 9'}
                strokeLinejoin="round"
              />
              {road.blocked && (
                <g
                  transform={`translate(${road.points[1][0] + 45} ${road.points[1][1] - 25})`}
                >
                  <rect
                    x="-8"
                    y="-17"
                    width="117"
                    height="25"
                    rx="5"
                    fill="#61352b"
                    stroke="#e49375"
                  />
                  <text fill="#ffe8d9" fontSize="12">
                    ⊘ {road.label} 통제
                  </text>
                </g>
              )}
            </g>
          ))}
          <g transform={`translate(${map.office.x} ${map.office.y})`}>
            <rect
              x="-23"
              y="-17"
              width="52"
              height="36"
              fill="#1d2c23"
              opacity=".4"
              transform="translate(4 5)"
            />
            <rect
              x="-25"
              y="-20"
              width="50"
              height="32"
              fill={`url(#${id}-roof)`}
              stroke="#d4ceba"
            />
            <path d="M-23-4h46" stroke="#e0d9c0" strokeWidth="2" />
            <text
              className="terrain-label"
              y="33"
              textAnchor="middle"
              fontSize="13"
            >
              면사무소
            </text>
          </g>
          {shelters.map((sh) => (
            <g
              key={sh.id}
              transform={`translate(${sh.demoLocation.x} ${sh.demoLocation.y})`}
            >
              <rect
                x="-27"
                y="-24"
                width="58"
                height="40"
                fill="#182b24"
                opacity=".4"
                transform="translate(4 6)"
              />
              <rect
                x="-29"
                y="-27"
                width="58"
                height="38"
                rx="2"
                fill={`url(#${id}-roof)`}
                stroke="#b6c4b4"
              />
              <path d="M-27-8h54" stroke="#cbd9c6" strokeWidth="2" />
              <circle
                cy="-7"
                r="15"
                fill="#e1f0d9"
                stroke="#416b47"
                strokeWidth="2"
              />
              <path
                d="M-8-7L0-14l8 7M-6-8V1H6V-8M-2 1v-6h4v6"
                fill="none"
                stroke="#375a3d"
                strokeWidth="2"
              />
              <rect
                x="-43"
                y="22"
                width="86"
                height="23"
                rx="5"
                fill="#214231"
                stroke="#95b897"
              />
              <text
                y="38"
                textAnchor="middle"
                fontSize="13"
                fill="#eff7e9"
                fontWeight="600"
              >
                {sh.type} · 대피소
              </text>
            </g>
          ))}
          {teams.map((team) => (
            <g
              key={team.id}
              transform={`translate(${team.meetingPoint.x - 18} ${team.meetingPoint.y + 24})`}
            >
              <path
                d="M-8-2L0-10l8 8v9h-16Z"
                fill="#dae5df"
                stroke="#334d4a"
                strokeWidth="2"
              />
              <text className="terrain-label" x="14" y="5" fontSize="12">
                {team.zoneId}조 집결
              </text>
            </g>
          ))}
          {households.map((h) => (
            <g
              key={`building-${h.id}`}
              transform={`translate(${h.demoPosition.x} ${h.demoPosition.y})`}
            >
              <rect
                x="-10"
                y="-6"
                width="24"
                height="18"
                rx="1"
                fill="#1c2920"
                opacity=".6"
                transform="translate(4 5)"
              />
              <rect
                x="-12"
                y="-9"
                width="24"
                height="17"
                fill={h.zoneId === 'N' ? '#b6a98b' : '#d2cbb7'}
                stroke="#777b6d"
              />
              <path
                d="M-13-10h26v9h-26Z"
                fill={
                  h.zoneId === 'N'
                    ? '#a59379'
                    : h.zoneId === 'E'
                      ? '#7f9a99'
                      : '#9b9e8d'
                }
                stroke="#d6cfb9"
                strokeWidth=".8"
              />
              <path
                d="M-13-1h26v9h-26Z"
                fill={h.zoneId === 'E' ? '#536d71' : '#73796b'}
              />
              <path d="M-13-1h26" stroke="#d1c8ac" />
              <rect x="5" y="-6" width="4" height="3" fill="#c4d1cb" />
            </g>
          ))}
          {spreadAvailable && (
            <ForestLayers
              id={id}
              map={map}
              spread={forest}
              fire={fire}
              future={future}
              smoke={smoke}
              time={time}
              showFire={layers.fire}
              showForecast={layers.forecast}
              showSmoke={layers.smoke}
            />
          )}
          {zones.map((zone) => {
            const zoneLabel = spreadAvailable
              ? forestZoneLabel(zone, fire, smoke)
              : 'ETA 불명';
            return (
              <g
                key={zone.id}
                transform={`translate(${zone.demoBounds.x1 + 8} ${zone.demoBounds.y1 - (zone.id === 'N' ? -7 : 22)})`}
              >
                <rect
                  x="-6"
                  y="-16"
                  width={active ? 143 : 83}
                  height="29"
                  rx="5"
                  fill="#24372e"
                  fillOpacity=".9"
                  stroke="#afbd9b"
                  strokeOpacity=".6"
                />
                <text fontSize="14" fill="#edf2df" fontWeight="650" y="4">
                  {zone.label}
                  {active ? ` · ${zoneLabel}` : ` · ${zone.householdCount}`}
                </text>
              </g>
            );
          })}
          {visibleMotions.map((m) => (
            <g key={`route-${m.id}`}>
              {m.tripId && !view.showcase ? (
                Object.entries(
                  view.trips.find((t) => t.id === m.tripId)!.legs,
                ).map(([leg, route]) => (
                  <polyline
                    key={leg}
                    data-testid="trip-route"
                    points={pathPoints(route.waypoints)}
                    fill="none"
                    stroke={m.held ? '#8A0715' : '#D9A700'}
                    strokeWidth="3"
                    strokeDasharray="7 5"
                    opacity=".85"
                  />
                ))
              ) : (
                <>
                  <polyline
                    points={pathPoints(m.route.waypoints)}
                    fill="none"
                    stroke="#152d2a"
                    strokeWidth={m.kind === 'person' ? '5' : '6'}
                    opacity=".7"
                  />
                  <polyline
                    className="motion-route"
                    data-testid="movement-route"
                    points={pathPoints(m.route.waypoints)}
                    fill="none"
                    stroke={m.kind === 'person' ? '#FA4616' : '#D9A700'}
                    strokeWidth={m.kind === 'person' ? '2.5' : '3.5'}
                    strokeDasharray={m.kind === 'person' ? '4 7' : '9 6'}
                    opacity=".9"
                  />
                </>
              )}
            </g>
          ))}
          {households.map((h) => {
            const st = view.scenario.householdStatuses.find(
              (s) => s.householdId === h.id,
            )!;
            const group = groupOf(h, st);
            return (
              <g
                key={h.id}
                role="button"
                tabIndex={0}
                data-testid={
                  demoResidentId === h.id ? 'demo-resident-marker' : undefined
                }
                className={`household-pin ${selected === h.id ? 'is-selected' : ''} ${demoResidentId === h.id ? 'demo-household-pin' : ''}`}
                aria-label={`${h.id} ${h.name} ${GROUP_LABELS[group]}`}
                onClick={() => setSelected(h.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected(h.id);
                  }
                }}
              >
                {(demoResidentId === h.id ||
                  (view.showcase && h.id === 'H009')) && (
                  <g className="demo-home-highlight" pointerEvents="none">
                    <circle
                      cx={h.demoPosition.x}
                      cy={h.demoPosition.y}
                      r="32"
                      fill="#D9A700"
                      fillOpacity=".16"
                      stroke="#D9A700"
                      strokeWidth="3"
                    />
                    <rect
                      x={h.demoPosition.x - 65}
                      y={h.demoPosition.y + 18}
                      width="130"
                      height="26"
                      rx="6"
                      fill="#203d31"
                      stroke="#D9A700"
                    />
                    <text
                      x={h.demoPosition.x}
                      y={h.demoPosition.y + 36}
                      textAnchor="middle"
                      fill="#FFF4D6"
                      fontSize="12"
                      fontWeight="700"
                    >
                      {view.showcase
                        ? `${h.name} 집`
                        : (view.demonstration?.story ?? featuredStory) ===
                            'grandfather'
                          ? '반영환 할아버지 집'
                          : '박미숙 할머니 집'}
                    </text>
                  </g>
                )}
                <circle
                  cx={h.demoPosition.x}
                  cy={h.demoPosition.y}
                  r="22"
                  fill="transparent"
                />
                <path
                  d={`M${h.demoPosition.x - 3} ${h.demoPosition.y - 11}l3 6 3-6`}
                  fill={MAP_COLORS[group]}
                  stroke="#20372b"
                />
                <circle
                  data-testid="household-marker"
                  cx={h.demoPosition.x}
                  cy={h.demoPosition.y - 23}
                  r="12"
                  fill={MAP_COLORS[group]}
                  stroke={selected === h.id ? '#fff8da' : '#23362b'}
                  strokeWidth={selected === h.id ? '3' : '2'}
                />
                <text
                  x={h.demoPosition.x}
                  y={h.demoPosition.y - 19}
                  textAnchor="middle"
                  fill="#142b28"
                  fontSize="10"
                  fontWeight="750"
                  pointerEvents="none"
                >
                  {h.id.slice(-2)}
                </text>
                <title>
                  {h.id} · {h.name} · {STATUS_LABELS[st.status]}
                </title>
              </g>
            );
          })}
          {displayMotions.map((motion, i) => (
            <MotionMarker
              key={motion.id}
              motion={motion}
              labelOffset={labelOffsets[i]}
              select={setSelected}
              featured={
                motion.kind === 'vehicle' && motion.id === demoVehicleId
              }
            />
          ))}
        </svg>
        <div className="terrain-hud map-hud">
          <span className={`map-live-dot ${active ? 'active' : ''}`} />
          <div>
            <strong>
              {view.frozen
                ? '종료 시점 기록'
                : active
                  ? '대피 대응 현황'
                  : view.scenario.mode === 'watch'
                    ? '산불 감시 중'
                    : '평시 · 명단 관리'}
            </strong>
            <small>
              {cycle
                ? `공용 시계 T+${view.simMinutes.toFixed(1)}분 · ${view.simulation.playing ? `${view.simulation.speed}× 진행` : '정지'}`
                : active
                  ? `기준 T+${view.simMinutes}분${preview > 0 ? ` · +${preview.toFixed(1)}분 미리보기` : ''}`
                  : '지형·건물·도로 상세 보기'}
            </small>
            {active && !view.showcase && !windEvidence.usable && (
              <small className="map-evidence-warning">
                바람 근거 불명/낡음 · 확산 표시 보류
              </small>
            )}
          </div>
        </div>
        <div className="terrain-wind">
          <div className="wind-compass" aria-hidden="true">
            <small>N</small>
            <span
              style={{
                transform: `rotate(${(Math.atan2(-Math.cos(theta), Math.sin(theta)) * 180) / Math.PI}deg)`,
              }}
            >
              ➜
            </span>
          </div>
          <strong>
            {active && !view.showcase && !windEvidence.usable
              ? '불명'
              : map.wind.speedMps}{' '}
            <small>
              {active && !view.showcase && !windEvidence.usable ? '' : 'm/s'}
            </small>
          </strong>
          <span>
            {active && !view.showcase && !windEvidence.usable
              ? '관측 확인 필요'
              : `풍향 ${map.wind.direction}°`}
          </span>
        </div>
        <div className="map-zoom-tools">
          <button
            aria-label="지도 확대"
            disabled={zoom >= 3}
            onClick={() => setZoom(Math.min(3, zoom + 0.5))}
          >
            +
          </button>
          <button
            aria-label="지도 축소"
            disabled={zoom <= 1}
            onClick={() => {
              setZoom(Math.max(1, zoom - 0.5));
              setCenter({ x: 600, y: 380 });
            }}
          >
            −
          </button>
          <button
            aria-label="지도 시점 초기화"
            onClick={() => {
              setZoom(1);
              setCenter({ x: 600, y: 380 });
            }}
          >
            ⌖
          </button>
        </div>
        <div
          className="terrain-scale"
          style={{ width: `${(100 / width) * 100}%` }}
        >
          <span />
          <small>200m</small>
        </div>
        <div className="terrain-legend">
          {(['act', 'prog', 'safe', 'visit'] as const).map((group) => (
            <span key={group}>
              <i style={{ background: MAP_COLORS[group] }} />
              {GROUP_LABELS[group]} <b>{c[group]}</b>
            </span>
          ))}
          <span className="legend-fire">
            <i />
            {preview > 0 ? '숲 화선 미리보기' : '숲 화선'}
          </span>
          <span className="legend-forecast">
            <i />
            10분 후
          </span>
          <span className="legend-smoke">
            <i />
            연기 흐름
          </span>
        </div>
      </div>
      {cycle ? (
        <div className="map-cycle-clock" data-testid="map-cycle-clock">
          <strong>공용 시계 T+{view.simMinutes.toFixed(1)}분</strong>
          <span>
            주민·차량·화선이 같은 시연 시간을 사용합니다. 재생·배속은 상단에서
            조절하세요.
          </span>
        </div>
      ) : (
        <div className="map-playback" aria-label="이동·산불 미리보기 재생">
          <button
            className="map-play-button"
            aria-label={
              playing
                ? '이동·확산 미리보기 일시정지'
                : '이동·확산 미리보기 재생'
            }
            disabled={!active || view.frozen}
            onClick={() => {
              if (preview >= 15) setPreview(0);
              setPlaying(!playing);
            }}
          >
            {playing ? 'Ⅱ' : '▶'}
          </button>
          <div className="map-play-speeds" aria-label="재생 속도">
            {[12, 30, 60].map((value) => (
              <button
                key={value}
                aria-pressed={speed === value}
                onClick={() => setSpeed(value)}
              >
                {value}×
              </button>
            ))}
          </div>
          <label className="map-time-slider">
            <span>이동·확산 미리보기</span>
            <input
              aria-label="미리보기 시간"
              type="range"
              min="0"
              max="15"
              step=".1"
              value={preview}
              disabled={!active || view.frozen}
              onChange={(e) => {
                setPreview(Number(e.target.value));
                setPlaying(false);
              }}
            />
          </label>
          <output data-testid="preview-time">+{preview.toFixed(1)}분</output>
          <button
            className="map-reset-preview"
            aria-label="미리보기 초기화"
            onClick={() => {
              setPreview(0);
              setPlaying(false);
            }}
          >
            ↺
          </button>
        </div>
      )}
      <div className="map-movement-summary">
        <div>
          <span className="summary-icon people-icon">♟</span>
          <span>
            주민 이동
            <strong>
              {people.length}
              <small>가구</small>
            </strong>
          </span>
        </div>
        <div>
          <span className="summary-icon vehicle-icon">▰</span>
          <span>
            차량 출동·수송
            <strong>
              {vehicles.length}
              <small>대</small>
            </strong>
          </span>
        </div>
        <div>
          <span className="summary-icon fire-icon">♨</span>
          <span>
            산불 확산
            <strong>
              {active
                ? spreadAvailable
                  ? `T+${time.toFixed(1)}`
                  : '불명'
                : '감시'}
              <small>
                {active ? (spreadAvailable ? '분' : '관측 확인') : '대기'}
              </small>
            </strong>
          </span>
        </div>
        <div className="map-summary-note">
          {active
            ? '주황 동선은 주민, 노란 동선은 차량입니다.'
            : '발생 대응 장면에서 이동·확산을 확인할 수 있습니다.'}
          <small>
            불은 연결된 숲을 따라 번지고, 연기는 바람을 따라 마을 위로 흐릅니다.
          </small>
        </div>
      </div>
      <div className="map-footer">
        <span>
          합성 지형·경로 · 실제 GPS·위성 영상 아님 · 산불 범위는 비공식 데모
          모델
        </span>
        {!cycle && (
          <Btn
            size="sm"
            kind="outline"
            disabled={!view.plan?.confirmed || view.networkDown || view.frozen}
            onClick={() => void run('advance')}
          >
            모의 1분 진행
          </Btn>
        )}
      </div>
      {household && status && (
        <Card>
          <div className="between">
            <h3>
              {household.id} {household.name}
            </h3>
            <button className="text-button" onClick={() => setSelected(null)}>
              닫기
            </button>
          </div>
          <p>
            {household.mobility} · 취약 {household.priorityGrade} ·{' '}
            {household.phoneKind} · 담당 {household.teamId}
          </p>
          <p>
            <span className={`state ${groupOf(household, status)}`}>
              {status.temporaryExclusion ?? STATUS_LABELS[status.status]}
            </span>{' '}
            · {nextAction(status)}
          </p>
          <Btn size="sm" kind="outline" onClick={() => open(household.id)}>
            가구 상세 열기
          </Btn>
        </Card>
      )}
    </div>
  );
}
