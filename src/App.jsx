import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import baselineTimeline from '../output/agents_timeline_baseline.json';
import congestionTimeline from '../output/agents_timeline_congestion.json';
import carboncreditTimeline from '../output/agents_timeline_carboncredit.json';
import labLogo from './img/favicon.jpeg';
// 加载拥堵区 GeoJSON 的 URL（由 Vite 解析为静态资源路径）
const CONGESTION_ZONE_URL = new URL('./data/policies/congestion_zone_example.geojson', import.meta.url).href;

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

// 新增：样式与回退样式（无 Token 时或被阻断时使用）
const MAP_STYLE = import.meta.env.VITE_MAPBOX_STYLE || 'mapbox://styles/mapbox/light-v11';
const FALLBACK_STYLE = 'https://demotiles.maplibre.org/style.json';

const DEFAULT_VIEW = {
  center: [113.2644, 23.1291],
  zoom: 11,
};
const DAY_SECONDS = 24 * 3600;

const MODE_COLORS = {
  car: [28, 144, 255],      // blue
  taxi: [250, 204, 21],     // yellow
  bus: [34, 197, 94],       // green
  bike: [139, 92, 246],     // purple
  walk: [120, 120, 120]     // gray
};
const colorToCss = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

const DEFAULT_EF = { 
  car_ice: 200, 
  car_ev: 100, 
  bus: 40, bike: 0, walk: 0 };
// Display order for modes in panels
const MODE_ORDER = ['walk', 'bike', 'bus', 'car_ev', 'car_ice'];
// Carbon credit weights by travel mode (points per km)
// Higher weight rewards low-carbon choices
const CARBON_WEIGHTS = {
  walk: 5,
  bike: 4,
  bus: 2,
  subway: 2,
  car_ev: 1,
  car_ice: 0
};
function lerpColor(a, b, t) {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * clamped),
    Math.round(a[1] + (b[1] - a[1]) * clamped),
    Math.round(a[2] + (b[2] - a[2]) * clamped)
  ];
}
function efToColor(ef) {
  const green = [34, 197, 94];   // 低排放
  const yellow = [250, 204, 21]; // 中排放
  const red = [220, 38, 38];     // 高排放
  if (ef <= 0) return green;
  if (ef <= 100) return lerpColor(green, yellow, ef / 100);
  if (ef <= 170) return lerpColor(yellow, red, (ef - 100) / 70);
  return red;
}
function modeColor(mode, efMap) {
  const v = efMap?.[mode];
  if (typeof v === 'number') return efToColor(v);
  return efToColor(DEFAULT_EF[mode] ?? 0);
}
// 新增：按污染强度的固定配色映射
const POLLUTION_COLORS = {
  car_ice: [220, 38, 38],   // red 高污染（燃油车）
  car_ev: [251, 146, 60],   // orange 次高污染（电车用电排放）
  bus: [250, 204, 21],      // yellow 中污染（公交）
  bike: [134, 239, 172],    // light green 低污染
  walk: [167, 243, 208],    // light green 低污染
};
const REASONING_COLOR_PALETTE = [
  '#4c6ef5',
  '#f59f00',
  '#12b886',
  '#e64980',
  '#845ef7',
  '#2fb344',
  '#ff922b'
];
const SCENARIO_DATA = {
  baseline: baselineTimeline,
  congestion_pricing: congestionTimeline,
  // Carbon credits is a visualization scenario; it uses baseline data
  carbon_credits: carboncreditTimeline
};

const SCENARIO_OPTIONS = [
  { value: 'baseline', label: 'Baseline', enabled: true },
  { value: 'congestion_pricing', label: 'Congestion Pricing', enabled: true },
  { value: 'carbon_credits', label: 'Carbon Credits', enabled: true },
  { value: 'measure1', label: 'Measure 1', enabled: false },
  { value: 'measure2', label: 'Measure 2', enabled: false },
  { value: 'measure3', label: 'Measure 3', enabled: false },
  { value: 'measure4', label: 'Measure 4', enabled: false },
  { value: 'measure5', label: 'Measure 5', enabled: false }
];
function pollutionColor(mode, efMap) {
  const m = String(mode || '').toLowerCase();
  if (POLLUTION_COLORS[m]) return POLLUTION_COLORS[m];
  // 未定义的模式使用排放梯度作为回退
  return modeColor(m, efMap);
}
function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function computeLegDistanceKm(path) {
  let dist = 0;
  for (let i = 1; i < path.length; i++) dist += haversineKm(path[i - 1], path[i]);
  return dist;
}

function normalizePathWithTime(path, startTime, endTime) {
  if (!Array.isArray(path)) return [];
  const cleaned = path
    .map((point) => {
      if (!point) return null;
      if (Array.isArray(point)) {
        const [lng, lat, t] = point;
        return { lng, lat, t: typeof t === 'number' ? t : undefined };
      }
      if (typeof point === 'object') {
        const lng = point.lng ?? point.lon ?? point.longitude ?? point.x;
        const lat = point.lat ?? point.latitude ?? point.y;
        const time = point.t ?? point.time ?? point.timestamp;
        if (typeof lng !== 'number' || typeof lat !== 'number') return null;
        return { lng, lat, t: typeof time === 'number' ? time : undefined };
      }
      return null;
    })
    .filter(Boolean);

  if (!cleaned.length) return [];
  const hasTime = cleaned.every((p) => typeof p.t === 'number');
  if (hasTime) return cleaned;

  if (typeof startTime !== 'number' || typeof endTime !== 'number' || endTime <= startTime) {
    const base = typeof startTime === 'number' ? startTime : 0;
    return cleaned.map((p) => ({ ...p, t: base }));
  }

  const duration = endTime - startTime;
  const steps = cleaned.length - 1 || 1;
  return cleaned.map((p, idx) => ({
    ...p,
    t: startTime + (duration * idx) / steps
  }));
}

function extractLegs(agent) {
  if (!agent) return [];
  const legs = Array.isArray(agent.legs) ? agent.legs : [];
  if (legs.length) {
    return legs.map((leg) => {
      const start = leg.start_time ?? leg.startTime ?? leg.path?.[0]?.t;
      const end = leg.end_time ?? leg.endTime ?? leg.path?.[leg.path.length - 1]?.t;
      const path = normalizePathWithTime(leg.path ?? [], start, end);
      return { ...leg, mode: leg.mode ?? agent.mode, path };
    });
  }
  if (!Array.isArray(agent.timeline)) return [];
  return agent.timeline
    .filter((entry) => entry?.type === 'move')
    .map((move) => ({
      start_time: move.start_time ?? move.startTime ?? 0,
      end_time: move.end_time ?? move.endTime ?? 0,
      mode: move.mode ?? agent.mode,
      duration_s: move.duration_s ?? move.duration ?? 0,
      distance_m: move.distance_m ?? move.distance ?? null,
      reasoning: move.reasoning,
      rationale: move.rationale,
      path: normalizePathWithTime(move.path ?? [], move.start_time ?? move.startTime ?? 0, move.end_time ?? move.endTime ?? 0)
    }));
}

function getAgentPosition(agent, time) {
  if (!agent?.legs?.length) return null;
  let fallback = null;
  for (const leg of agent.legs) {
    const path = Array.isArray(leg.path) ? leg.path : [];
    if (!path.length) continue;
    const start = leg.start_time ?? leg.startTime ?? path[0]?.t;
    const end = leg.end_time ?? leg.endTime ?? path[path.length - 1]?.t;
    if (typeof start !== 'number' || typeof end !== 'number' || end === start) continue;

    const startCoord = [path[0].lng, path[0].lat];
    const endCoord = [path[path.length - 1].lng, path[path.length - 1].lat];

    if (time <= start) {
      return { position: startCoord, mode: leg.mode ?? agent.mode };
    }
    if (time >= end) {
      fallback = { position: endCoord, mode: leg.mode ?? agent.mode };
      continue;
    }
    const interpolated = interpolateLngLat(path, time);
    if (interpolated) {
      return { position: interpolated, mode: leg.mode ?? agent.mode };
    }
    // fallback to linear interpolation if interpolateLngLat failed
    const ratio = (time - start) / (end - start);
    const lng = startCoord[0] + (endCoord[0] - startCoord[0]) * ratio;
    const lat = startCoord[1] + (endCoord[1] - startCoord[1]) * ratio;
    return { position: [lng, lat], mode: leg.mode ?? agent.mode };
  }
  return fallback;
}

function interpolateLngLat(path, t) {
  if (!path || path.length === 0) return null;
  const n = path.length;
  if (t <= path[0].t) return [path[0].lng, path[0].lat];
  if (t >= path[n - 1].t) return [path[n - 1].lng, path[n - 1].lat];
  for (let i = 0; i < n - 1; i++) {
    const p = path[i];
    const q = path[i + 1];
    if (t >= p.t && t <= q.t) {
      const f = (t - p.t) / (q.t - p.t);
      return [p.lng + f * (q.lng - p.lng), p.lat + f * (q.lat - p.lat)];
    }
  }
  return null;
}

// 顶部时间格式化
function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const str = `${h}:${m}`;
  return str;
}

function titleCaseFromMode(mode) {
  if (!mode) return 'Unknown';
  return String(mode)
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatDistanceMeters(distanceMeters) {
  if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters)) return null;
  if (distanceMeters < 1000) {
    return `${Math.round(distanceMeters)} m`;
  }
  const km = distanceMeters / 1000;
  if (km >= 10) return `${km.toFixed(0)} km`;
  if (km >= 1) return `${km.toFixed(1)} km`;
  return `${km.toFixed(2)} km`;
}

function formatDurationSeconds(durationSeconds) {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }
  if (durationSeconds < 180) {
    return `${Math.round(durationSeconds)} s`;
  }
  const minutes = Math.round(durationSeconds / 60);
  return `${minutes} min`;
}

function buildReasoningLogsFromScenario(scenario) {
  if (!scenario) return [];
  const agents = Array.isArray(scenario.agents) ? scenario.agents : [];
  const logs = [];

  for (const agent of agents) {
    const legs = extractLegs(agent);
    let moveIndex = 0;
    for (const leg of legs) {
      moveIndex += 1;
      const start = leg.start_time ?? leg.startTime ?? leg.path?.[0]?.t ?? null;
      const modeRaw = leg.mode ?? agent.mode ?? 'unknown';
      const modeLabel = titleCaseFromMode(modeRaw);
      const distanceText = formatDistanceMeters(
        typeof leg.distance_m === 'number'
          ? leg.distance_m
          : (typeof leg.distance_km === 'number' ? leg.distance_km * 1000 : null)
      );
      const durationText = formatDurationSeconds(leg.duration_s ?? leg.duration ?? null);
      const metrics = [distanceText, durationText].filter(Boolean);
      const reasoningSourceRaw = [leg.reasoning, agent.reasoning, agent.rationale]
        .find((entry) => {
          if (typeof entry === 'string') return entry.trim().length > 0;
          if (Array.isArray(entry)) return entry.some((chunk) => typeof chunk === 'string' && chunk.trim().length > 0);
          if (entry && typeof entry === 'object' && typeof entry.text === 'string') return entry.text.trim().length > 0;
          return false;
        });

      let reasonText = '';
      if (typeof reasoningSourceRaw === 'string') {
        reasonText = reasoningSourceRaw.trim();
      } else if (Array.isArray(reasoningSourceRaw)) {
        reasonText = reasoningSourceRaw
          .filter((chunk) => typeof chunk === 'string' && chunk.trim().length > 0)
          .map((chunk) => chunk.trim())
          .join(' ');
      } else if (reasoningSourceRaw && typeof reasoningSourceRaw === 'object' && typeof reasoningSourceRaw.text === 'string') {
        reasonText = reasoningSourceRaw.text.trim();
      }

      if (!reasonText) continue;

      if (metrics.length) {
        const summary = metrics.join(' · ');
        reasonText = `${reasonText} (${summary})`;
      }

      logs.push({
        agentId: agent.id ?? `Agent-${logs.length + 1}`,
        mode: modeRaw,
        reason: reasonText,
        timeLabel: typeof start === 'number' ? formatClock(start) : '--:--',
        timestamp: typeof start === 'number' ? start : Number.MAX_SAFE_INTEGER,
        moveIndex
      });
    }
  }

  logs.sort((a, b) => a.timestamp - b.timestamp);
  return logs;
}

// 生成基线场景（广州附近100个agent）
const MODES = ['walk', 'bike', 'car', 'taxi', 'bus'];
function generateBaselineScenario(count = 100) {
  const ef = { car: 170, taxi: 170, bus: 100, bike: 0, walk: 0 };
  const center = { lng: 113.2644, lat: 23.1291 };
  const agents = [];
  for (let i = 0; i < count; i++) {
    const id = `AG-${String(i + 1).padStart(3, '0')}`;
    const mode = MODES[Math.floor(Math.random() * MODES.length)];
    const start = 8 * 3600 + Math.floor(Math.random() * 7200); // 08:00 起，±2小时
    const duration = 900 + Math.floor(Math.random() * 1800); // 15–45 分钟
    const end = start + duration;
    const scale = { walk: 0.25, bike: 0.5, car: 1.0, taxi: 1.0, bus: 1.2 }[mode];
    const dLng = (Math.random() - 0.5) * 0.12 * scale;
    const dLat = (Math.random() - 0.5) * 0.08 * scale;
    const p0 = { lng: center.lng + (Math.random() - 0.5) * 0.06, lat: center.lat + (Math.random() - 0.5) * 0.04, t: start };
    const p1 = { lng: p0.lng + dLng * 0.33, lat: p0.lat + dLat * 0.33, t: start + Math.floor(duration * 0.33) };
    const p2 = { lng: p0.lng + dLng * 0.66, lat: p0.lat + dLat * 0.66, t: start + Math.floor(duration * 0.66) };
    const p3 = { lng: p0.lng + dLng, lat: p0.lat + dLat, t: end };
    agents.push({ id, mode, legs: [{ start_time: start, end_time: end, path: [p0, p1, p2, p3] }] });
  }
  return { meta: { date: '2024-10-01', city: 'Guangzhou', emission_factors_g_per_km: ef }, agents };
}

function App() {
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const overlayRef = useRef(null);
  // 新增：回退应用标记
  const fallbackAppliedRef = useRef(false);

  const [scenario, setScenario] = useState(null);
  const [rawScenario, setRawScenario] = useState(null);
  const [dayIndex, setDayIndex] = useState(1);
  const [currentTime, setCurrentTime] = useState(8 * 3600);
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState(50);
  const [scenarioName, setScenarioName] = useState('baseline');
  const [congestionZoneData, setCongestionZoneData] = useState(null);
  // const [timeCompression, setTimeCompression] = useState(1);
  const reasoningListRef = useRef(null);
  const [isReasoningPaused, setIsReasoningPaused] = useState(false);
  const reasoningScrollAnimRef = useRef(null);
  const reasoningScrollLastTimeRef = useRef(null);
  const [isCarbonCollapsed, setIsCarbonCollapsed] = useState(false);
  // Keep previous agent scores to compute per-tick deltas for animation
  const prevScoresRef = useRef({});
  // Ref for bottom UI bar to compute dynamic padding
  const uiRef = useRef(null);

  const cancelReasoningScrollAnimation = useCallback(() => {
    if (reasoningScrollAnimRef.current) {
      cancelAnimationFrame(reasoningScrollAnimRef.current);
      reasoningScrollAnimRef.current = null;
    }
    reasoningScrollLastTimeRef.current = null;
  }, []);

  // 加载场景数据：根据当前选择提取第 1 天
  useEffect(() => {
    const data = SCENARIO_DATA[scenarioName] ?? baselineTimeline;
    const scenarioSingle = Array.isArray(data?.days) ? data.days[0] : data;
    setRawScenario(data);
    setScenario(scenarioSingle);
    setDayIndex(1);
  }, [scenarioName]);

  // 读取拥堵区 GeoJSON
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(CONGESTION_ZONE_URL);
        const gj = await res.json();
        setCongestionZoneData(gj);
      } catch (err) {
        // 读取失败忽略
      }
    })();
  }, []);

  const reasoningLogs = useMemo(() => buildReasoningLogsFromScenario(scenario), [scenario]);

  // 新日志时重置滚动位置
  useEffect(() => {
    const listEl = reasoningListRef.current;
    if (listEl) {
      listEl.scrollTop = 0;
    }
    cancelReasoningScrollAnimation();
  }, [reasoningLogs]);

  useEffect(() => cancelReasoningScrollAnimation, [cancelReasoningScrollAnimation]);
  useEffect(() => {
    const container = reasoningListRef.current;
    if (!container || !reasoningLogs.length) {
      cancelReasoningScrollAnimation();
      return;
    }

    if (isReasoningPaused) {
      cancelReasoningScrollAnimation();
      return;
    }

    const SCROLL_SPEED = 100; // pixels per second (slowed down)

    const animate = (timestamp) => {
      if (!reasoningListRef.current) {
        cancelReasoningScrollAnimation();
        return;
      }

      const last = reasoningScrollLastTimeRef.current ?? timestamp;
      const dt = Math.max(0, (timestamp - last) / 1000);
      reasoningScrollLastTimeRef.current = timestamp;

      const frameContainer = reasoningListRef.current;
      const maxScroll = Math.max(0, frameContainer.scrollHeight - frameContainer.clientHeight);

      if (maxScroll <= 0) {
        cancelReasoningScrollAnimation();
        return;
      }

      let nextTop = frameContainer.scrollTop + dt * SCROLL_SPEED;
      if (nextTop >= maxScroll) {
        nextTop = 0;
        reasoningScrollLastTimeRef.current = timestamp;
      }
      frameContainer.scrollTop = nextTop;
      reasoningScrollAnimRef.current = requestAnimationFrame(animate);
    };

    reasoningScrollAnimRef.current = requestAnimationFrame(animate);
    return cancelReasoningScrollAnimation;
  }, [cancelReasoningScrollAnimation, isReasoningPaused, reasoningLogs]);

  const precomputed = useMemo(() => {
    if (!scenario) return null;
    const ef = scenario.meta?.emission_factors_g_per_km || DEFAULT_EF;

    let minT = Infinity;
    let maxT = -Infinity;
    const byModeTimes = {};

    const agentsSource = Array.isArray(scenario.agents) ? scenario.agents : [];
    const agents = agentsSource.map((a) => {
      const legsNormalized = extractLegs(a);
      const legs = legsNormalized.map((leg) => {
        const legMode = leg.mode ?? a.mode;
        const path = Array.isArray(leg.path) ? leg.path : [];
        const distance_km = typeof leg.distance_m === 'number'
          ? leg.distance_m / 1000
          : computeLegDistanceKm(path);
        const emission_g = distance_km * (ef[legMode] ?? ef[a.mode] ?? 0);
        minT = Math.min(minT, leg.start_time ?? path?.[0]?.t ?? minT);
        maxT = Math.max(maxT, leg.end_time ?? path?.[path.length - 1]?.t ?? maxT);
        const tEnd = leg.end_time ?? path?.[path.length - 1]?.t;
        if (tEnd != null) {
          byModeTimes[legMode] = byModeTimes[legMode] || [];
          byModeTimes[legMode].push({ t: tEnd, emission_g });
        }
        return { ...leg, mode: legMode, path, distance_km, emission_g };
      });
      return { ...a, legs };
    });

    // 全部累计
    const timesAll = [];
    for (const a of agents) {
      for (const leg of a.legs) {
        const t = leg.end_time ?? leg.path?.[leg.path.length - 1]?.t;
        if (t != null) timesAll.push({ t, emission_g: leg.emission_g });
      }
    }
    timesAll.sort((x, y) => x.t - y.t);
    let cumAll = 0;
    const cumulative = timesAll.map((p) => ({ t: p.t, emission_g_cum: (cumAll += p.emission_g) }));

    // 分模式累计
    const cumulativesByMode = {};
    const modeTotals = {};
    for (const [mode, arr] of Object.entries(byModeTimes)) {
      arr.sort((x, y) => x.t - y.t);
      let cum = 0;
      cumulativesByMode[mode] = arr.map((p) => ({ t: p.t, emission_g_cum: (cum += p.emission_g) }));
      modeTotals[mode] = cum;
    }

    const total_emission_g = cumulative.length ? cumulative[cumulative.length - 1].emission_g_cum : 0;

    return {
      agents,
      cumulative,
      cumulativesByMode,
      modeTotals,
      minT: isFinite(minT) ? minT : 0,
      maxT: isFinite(maxT) ? maxT : 24 * 3600,
      total_emission_g
    };
  }, [scenario]);

  // On scenario switch, fix timeline start at 08:00 (do not snap to earliest event)
  useEffect(() => {
    setCurrentTime(8 * 3600);
  }, [scenario]);

  // 播放动画时间推进
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000; // 秒
      last = now;
      setCurrentTime((t) => Math.min(t + dt * speed, DAY_SECONDS));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [isPlaying, speed, precomputed?.maxT]);

  // 初始化 Mapbox 与 deck.gl overlay（增加回退）
  useEffect(() => {
    if (mapRef.current) return;
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: (mapboxgl.accessToken ? MAP_STYLE : FALLBACK_STYLE),
      center: DEFAULT_VIEW.center,
      zoom: DEFAULT_VIEW.zoom
    });
    mapRef.current = map;

    // 如果样式加载报错（例如 Token 无效或被网络阻断），回退到开源样式
    map.on('error', (e) => {
      if (fallbackAppliedRef.current) return;
      const msg = String(e?.error?.message || '');
      const isMapboxErr = msg.includes('Forbidden') || msg.includes('Unauthorized') || msg.includes('NetworkError') || msg.includes('Abort') || msg.includes('api.mapbox.com');
      if (isMapboxErr) {
        fallbackAppliedRef.current = true;
        try {
          map.setStyle(FALLBACK_STYLE);
        } catch (err) {
          // noop
        }
      }
    });
    overlayRef.current = new MapboxOverlay({ layers: [] });
    map.addControl(overlayRef.current);

    return () => {
      if (overlayRef.current) {
        map.removeControl(overlayRef.current);
        overlayRef.current.finalize();
      }
      map.remove();
    };
  }, []);

  // Fit map view to agent path bounds on scenario load (account for bottom UI overlay)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !precomputed) return;
    try {
      const bounds = new mapboxgl.LngLatBounds();
      let hasPoints = false;
      for (const a of precomputed.agents) {
        for (const leg of a.legs) {
          const path = Array.isArray(leg.path) ? leg.path : [];
          for (const p of path) {
            const lng = Number(p.lng);
            const lat = Number(p.lat);
            if (Number.isFinite(lng) && Number.isFinite(lat)) {
              bounds.extend([lng, lat]);
              hasPoints = true;
            }
          }
        }
      }
      if (hasPoints) {
        const uiRect = uiRef.current ? uiRef.current.getBoundingClientRect() : null;
        // Bottom padding: UI height + extra spacing, clamped
        const bottomPadding = uiRect ? Math.min(Math.max(uiRect.height + 16, 40), 240) : 60;
        map.fitBounds(bounds, { padding: { top: 40, right: 40, bottom: bottomPadding, left: 40 }, maxZoom: 14, duration: 500 });
      } else {
        map.flyTo({ center: DEFAULT_VIEW.center, zoom: DEFAULT_VIEW.zoom });
      }
    } catch (e) {
      // ignore bounds errors
    }
  }, [precomputed]);

  // 构建图层：有 t 的用 TripsLayer，否则用 PathLayer
  const layers = useMemo(() => {
    if (!precomputed) return [];

    const efMapLocal = scenario?.meta?.emission_factors_g_per_km || DEFAULT_EF;
    const points = [];

    for (const agent of precomputed.agents) {
      const posInfo = getAgentPosition(agent, currentTime);
      if (!posInfo) continue;
      const color = pollutionColor(posInfo.mode ?? agent.mode, efMapLocal);
      points.push({
        agentId: agent.id,
        position: posInfo.position,
        color,
        mode: posInfo.mode ?? agent.mode
      });
    }

    if (!points.length) return [];

    const deckLayers = [
      new ScatterplotLayer({
        id: 'agents-points',
        data: points,
        getPosition: (d) => d.position,
        getFillColor: (d) => [...d.color, 220],
        getLineColor: [255, 255, 255, 220],
        lineWidthMinPixels: 1.2,
        stroked: true,
        radiusUnits: 'meters',
        getRadius: () => 90,
        radiusMinPixels: 3,
        radiusMaxPixels: 18,
        pickable: true
      })
    ];

    // Congestion pricing zone overlay（仅在选择该场景时显示）
    try {
      const windows = (congestionZoneData?.features?.[0]?.properties?.active_hours) || [];
      let active = false;
      if (Array.isArray(windows)) {
        for (const w of windows) {
          if (Array.isArray(w) && w.length === 2) {
            const s = Number(w[0]); const e = Number(w[1]);
            if (!Number.isNaN(s) && !Number.isNaN(e) && e > s) {
              if (currentTime >= s && currentTime <= e) { active = true; break; }
            }
          }
        }
      }
      if (scenarioName === 'congestion_pricing' && congestionZoneData) {
        deckLayers.push(new GeoJsonLayer({
          id: 'congestion-zone',
          data: congestionZoneData,
          stroked: true,
          filled: true,
          lineWidthMinPixels: 2,
          getLineColor: active ? [200, 0, 0, 255] : [180, 60, 0, 200],
          getFillColor: active ? [255, 90, 90, 60] : [255, 180, 90, 40],
          pickable: true,
          parameters: { depthTest: false }
        }));
      }
    } catch (e) {
      // ignore overlay errors
    }

    return deckLayers;
  }, [precomputed, currentTime, scenario, scenarioName, congestionZoneData]);

  // 更新 overlay 图层
  useEffect(() => {
    if (overlayRef.current) overlayRef.current.setProps({ layers });
  }, [layers]);

  const reasoningLogsWithColor = useMemo(() => {
    const efMapForReasoning = scenario?.meta?.emission_factors_g_per_km || DEFAULT_EF;
    return reasoningLogs.map((entry, idx) => {
      const modeColorArray = pollutionColor(entry.mode, efMapForReasoning);
      const cssColor = modeColorArray ? colorToCss(modeColorArray) : REASONING_COLOR_PALETTE[idx % REASONING_COLOR_PALETTE.length];
      const displayAgentId = String(entry.agentId || '').replace(/^GZ-/, 'Resident-');
      return {
        ...entry,
        color: cssColor,
        key: `${entry.agentId}-${idx}`,
        index: idx,
        displayAgentId
      };
    });
  }, [reasoningLogs, scenario]);

  // 计算当前累计排放
  const currentEmission = useMemo(() => {
    if (!precomputed) return 0;
    const cum = precomputed.cumulative;
    if (!cum.length) return 0;
    const idx = cum.findIndex((p) => p.t > currentTime);
    if (idx === -1) return cum[cum.length - 1].emission_g_cum;
    return idx > 0 ? cum[idx - 1].emission_g_cum : 0;
  }, [precomputed, currentTime]);

  const currentEmissionByMode = useMemo(() => {
    if (!precomputed) return {};
    const out = {};
    const byMode = precomputed.cumulativesByMode || {};
    for (const [mode, arr] of Object.entries(byMode)) {
      if (!arr.length) { out[mode] = 0; continue; }
      const idx = arr.findIndex((p) => p.t > currentTime);
      out[mode] = idx === -1 ? arr[arr.length - 1].emission_g_cum : (idx > 0 ? arr[idx - 1].emission_g_cum : 0);
    }
    return out;
  }, [precomputed, currentTime]);

  // Carbon credits leaderboard (dynamic): increases when a leg completes
  const carbonLeaderboard = useMemo(() => {
    if (!precomputed) return [];
    const rows = [];
    for (const a of precomputed.agents) {
      let score = 0;
      for (const leg of a.legs) {
        const tEnd = leg.end_time ?? leg.path?.[leg.path.length - 1]?.t;
        if (tEnd == null || currentTime < tEnd) continue; // count only completed legs
        const mRaw = leg.mode ?? a.mode;
        const m = String(mRaw || '').toLowerCase();
        const km = Number(leg.distance_km) || 0;
        if (!Number.isFinite(km) || km <= 0) continue;
        const w = CARBON_WEIGHTS[m] ?? 0;
        score += km * w;
      }
      const agentId = a.id ?? 'Unknown';
      const prev = prevScoresRef.current[agentId] || 0;
      const delta = Math.max(0, score - prev);
      rows.push({ agentId, score, delta });
    }
    rows.sort((x, y) => y.score - x.score);
    return rows;
  }, [precomputed, currentTime]);

  // Update previous scores after computing current leaderboard
  useEffect(() => {
    const nextMap = {};
    for (const row of carbonLeaderboard) nextMap[row.agentId] = row.score;
    prevScoresRef.current = nextMap;
  }, [carbonLeaderboard]);

  // 总天数：用于下拉框展示
  const totalDays = useMemo(() => {
    if (Array.isArray(rawScenario?.days)) return rawScenario.days.length;
    const md = Number(rawScenario?.meta?.days);
    return Number.isFinite(md) && md > 0 ? md : 1;
  }, [rawScenario]);

  return (
    <div>
      <div ref={mapContainerRef} id="map" />

      <div className="reasoning-panel">
        <div className="reasoning-header">
          <h3>LLM Reasoning Feed</h3>
          <span className="reasoning-subtitle">
            {reasoningLogs.length ? 'Scenario data · continuous auto-scroll' : 'No reasoning entries available'}
          </span>
        </div>
        <div
          className="reasoning-list"
          ref={reasoningListRef}
          onMouseEnter={() => setIsReasoningPaused(true)}
          onMouseLeave={() => setIsReasoningPaused(false)}
          onTouchStart={() => setIsReasoningPaused(true)}
          onTouchEnd={() => setIsReasoningPaused(false)}
        >
          {reasoningLogsWithColor.length ? (
            reasoningLogsWithColor.map((entry) => (
              <div className="reasoning-item" key={entry.key} data-idx={entry.index}>
                <span className="reasoning-dot" style={{ background: entry.color }} />
                <div className="reasoning-body">
                  <div className="reasoning-row">
                    <span className="reasoning-agent">{entry.displayAgentId || entry.agentId}</span>
                  </div>
                  <div className="reasoning-mode" style={{ color: entry.color }}>Mode · {entry.mode}</div>
                  <div className="reasoning-text">{entry.reason}</div>
                </div>
              </div>
            ))
          ) : (
            <div className="reasoning-empty">Connect an LLM planner or provide rationale fields to populate this feed.</div>
          )}
        </div>

        {/* Time-based statistics chart under the feed removed per request */}
      </div>

      {/* 顶部显示：天数与时间（下方追加政策说明） */}
      <div className="topbar">
        <div className="topbar-row">
          <div className="topbar-controls">
            <label className="topbar-label" htmlFor="scenario-select">Scenario:</label>
            <select
              id="scenario-select"
              className="topbar-select"
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
            >
              {SCENARIO_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} disabled={!option.enabled}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="topbar-time">Day {dayIndex} · {formatClock(currentTime)}</div>
        </div>
        {/* Congestion Pricing policy display removed as requested */}
      </div>

      {/* 底部控制条 */}
      <div className="ui" ref={uiRef}>
        <div className="row">
          <label>Day:</label>
          <select value={dayIndex} onChange={(e) => setDayIndex(Number(e.target.value))}>
            {Array.from({ length: totalDays }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>Day {d}</option>
            ))}
          </select>
        </div>
        {/* Policy summary moved to topbar */}
        <div className="row playback-row">
          <label>Playback:</label>
          <div className="button-group">
            <button
              type="button"
              className={isPlaying ? 'active' : ''}
              onClick={() => setIsPlaying(true)}
              disabled={isPlaying}
            >
              Play
            </button>
            <button
              type="button"
              className={!isPlaying ? 'active' : ''}
              onClick={() => setIsPlaying(false)}
              disabled={!isPlaying}
            >
              Pause
            </button>
          </div>
        </div>
        <div className="row speed-row">
          <label>Speed:</label>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            <option value={1}>1x</option>
            <option value={20}>20x</option>
            <option value={50}>50x</option>
            <option value={100}>100x</option>
            <option value={200}>200x</option>
          </select>
          <div className="lab-container" aria-label="UMEP Lab" title="UMEP Lab">
            <img src={labLogo} alt="UMEP Lab logo" className="lab-logo" />
            <span className="lab-name">UMEP Lab</span>
          </div>
        </div>
        <div className="row time-row">
          <label>Time:</label>
          <input type="range" min={0} max={DAY_SECONDS} step={60}
            value={currentTime} onChange={(e) => setCurrentTime(Number(e.target.value))} />
        </div>
      </div>

      {/* 在渲染前取出 efMap 供看板颜色使用 */}
      {(() => { /* 立即执行，确保作用域 */ })()}
      
      <div className="panel">
        <h3>Total CO₂ Today</h3>
        <div className="metric">{(currentEmission / 1000).toFixed(2)} kg CO₂</div>
        <div className="mode-list">
          {(() => {
            // 确保侧面板总是显示标准模式，即使当前值为 0
            const emissionModes = Array.from(new Set([
              ...MODE_ORDER,
              ...Object.keys(currentEmissionByMode || {})
            ]));
            const ordered = [
              ...MODE_ORDER.filter((m) => emissionModes.includes(m)),
              ...emissionModes.filter((m) => !MODE_ORDER.includes(m))
            ];
            return ordered.map((mode) => (
              <div key={mode} className="mode-row">
                <span className="mode-dot" style={{ background: colorToCss(pollutionColor(mode, (scenario?.meta?.emission_factors_g_per_km) || DEFAULT_EF)) }} />
                <span className="mode-label">{titleCaseFromMode(mode)}</span>
                <span className="mode-value">{((currentEmissionByMode[mode] || 0) / 1000).toFixed(2)} kg</span>
              </div>
            ));
          })()}
        </div>
        {/* Travel mode share moved from left reasoning panel to group stats */}
        <div className="reasoning-stats">
          <div className="stats-header">
            <span className="stats-title">Travel Mode Share Over Time</span>
          </div>
          {precomputed && precomputed.agents && precomputed.agents.length ? (
            (() => {
              const width = 360;
              const height = 120;
              const padL = 6, padR = 6, padT = 8, padB = 18;
              const w = width - padL - padR;
              const h = height - padT - padB;

              const bins = 24; // 24 hours
              const efMapForColors = scenario?.meta?.emission_factors_g_per_km || DEFAULT_EF;

              const countsPerBinByMode = Array.from({ length: bins }, () => ({}));
              const totalsPerBin = new Array(bins).fill(0);
              const modesSet = new Set();
              for (const a of precomputed.agents) {
                for (const leg of a.legs || []) {
                  const tEnd = leg.end_time ?? leg.path?.[leg.path.length - 1]?.t;
                  if (tEnd == null || tEnd > currentTime) continue; // only include completed trips up to current time
                  const idx = Math.max(0, Math.min(bins - 1, Math.floor(tEnd / 3600)));
                  const m = String(leg.mode || a.mode || 'unknown').toLowerCase();
                  if (m === 'unknown') continue;
                  countsPerBinByMode[idx][m] = (countsPerBinByMode[idx][m] || 0) + 1;
                  totalsPerBin[idx] += 1;
                  modesSet.add(m);
                }
              }

              const modesAll = Array.from(modesSet);
              const modes = [
                ...MODE_ORDER.filter((m) => modesAll.includes(m)),
                ...modesAll.filter((m) => !MODE_ORDER.includes(m))
              ];

              // Build shares per hour for each mode (length=bins)
              const sharesByMode = {};
              for (const m of modes) {
                sharesByMode[m] = new Array(bins).fill(0);
              }
              for (let i = 0; i < bins; i++) {
                const total = totalsPerBin[i];
                for (const m of modes) {
                  const cnt = countsPerBinByMode[i][m] || 0;
                  sharesByMode[m][i] = total > 0 ? Math.max(0, Math.min(1, cnt / total)) : 0;
                }
              }

              // Compute cumulative start/top per mode for stacked areas
              const cumStart = {}; const cumTop = {};
              for (const m of modes) { cumStart[m] = new Array(bins).fill(0); cumTop[m] = new Array(bins).fill(0); }
              for (let i = 0; i < bins; i++) {
                let acc = 0;
                for (const m of modes) {
                  cumStart[m][i] = acc;
                  acc += sharesByMode[m][i];
                  cumTop[m][i] = acc;
                }
              }

              const xOfHour = (i) => padL + ((bins > 1 ? i / (bins - 1) : 0) * w);
              const yOfShare = (s) => padT + (1 - s) * h;
              const xOfTime = (t) => padL + Math.max(0, Math.min(1, t / (24 * 3600))) * w;
              const ct = Math.min(Math.max(currentTime, 0), 24 * 3600);

              function areaPathForMode(m) {
                const top = cumTop[m];
                const bottom = cumStart[m];
                if (!top.length) return '';
                const parts = [];
                parts.push(`M${xOfHour(0).toFixed(2)},${yOfShare(top[0]).toFixed(2)}`);
                for (let i = 1; i < bins; i++) {
                  parts.push(`L${xOfHour(i).toFixed(2)},${yOfShare(top[i]).toFixed(2)}`);
                }
                for (let i = bins - 1; i >= 0; i--) {
                  parts.push(`L${xOfHour(i).toFixed(2)},${yOfShare(bottom[i]).toFixed(2)}`);
                }
                parts.push('Z');
                return parts.join(' ');
              }

              return (
                <svg className="stats-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
                  <rect x={0} y={0} width={width} height={height} rx={8} ry={8} fill="rgba(255,255,255,0.75)" stroke="rgba(0,0,0,0.08)" />
                  {[0.25, 0.5, 0.75].map((s) => (
                    <line key={`grid-${s}`} x1={padL} y1={yOfShare(s)} x2={padL + w} y2={yOfShare(s)} stroke="rgba(0,0,0,0.08)" />
                  ))}
                  <line x1={padL} y1={padT + h} x2={padL + w} y2={padT + h} stroke="rgba(0,0,0,0.12)" />
                  {modes.map((m) => {
                    const cArr = pollutionColor(m, efMapForColors);
                    const fill = `rgba(${cArr[0]},${cArr[1]},${cArr[2]},0.45)`;
                    const stroke = colorToCss(cArr);
                    const d = areaPathForMode(m);
                    return (
                      <path key={`area-${m}`} d={d} fill={fill} stroke={stroke} strokeWidth={0.6} />
                    );
                  })}
                  <line x1={xOfTime(ct)} y1={padT} x2={xOfTime(ct)} y2={padT + h} stroke="rgba(37,99,235,0.9)" strokeDasharray="3 3" />
                  {[0, 6, 12, 18, 24].map((hr) => {
                    const x = padL + (hr / 24) * w;
                    return (
                      <g key={`tick-${hr}`}>
                        <line x1={x} y1={padT + h} x2={x} y2={padT + h + 4} stroke="rgba(0,0,0,0.25)" />
                        <text x={x} y={padT + h + 12} fontSize={9} textAnchor="middle" fill="rgba(0,0,0,0.6)">{`${hr}h`}</text>
                      </g>
                    );
                  })}
                </svg>
              );
            })()
          ) : (
            (() => {
              const width = 360;
              const height = 120;
              const padL = 6, padR = 6, padT = 8, padB = 18;
              const w = width - padL - padR;
              const h = height - padT - padB;
              const xOfTime = (t) => padL + Math.max(0, Math.min(1, t / (24 * 3600))) * w;
              const yOfShare = (s) => padT + (1 - s) * h;
              const ct = Math.min(Math.max(currentTime, 0), 24 * 3600);
              return (
                <svg className="stats-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
                  <rect x={0} y={0} width={width} height={height} rx={8} ry={8} fill="rgba(255,255,255,0.75)" stroke="rgba(0,0,0,0.08)" />
                  {[0.25, 0.5, 0.75].map((s) => (
                    <line key={`grid-${s}`} x1={padL} y1={yOfShare(s)} x2={padL + w} y2={yOfShare(s)} stroke="rgba(0,0,0,0.08)" />
                  ))}
                  <line x1={padL} y1={padT + h} x2={padL + w} y2={padT + h} stroke="rgba(0,0,0,0.12)" />
                  {[0, 6, 12, 18, 24].map((hr) => (
                    <g key={`tick-${hr}`}>
                      <line x1={padL + (hr / 24) * w} y1={padT + h} x2={padL + (hr / 24) * w} y2={padT + h + 4} stroke="rgba(0,0,0,0.25)" />
                      <text x={padL + (hr / 24) * w} y={padT + h + 12} fontSize={9} textAnchor="middle" fill="rgba(0,0,0,0.6)">{`${hr}h`}</text>
                    </g>
                  ))}
                  <line x1={xOfTime(ct)} y1={padT} x2={xOfTime(ct)} y2={padT + h} stroke="rgba(37,99,235,0.9)" strokeDasharray="3 3" />
                </svg>
              );
            })()
          )}

          <div className="stats-legend">
            {(() => {
              const efMapForColors = scenario?.meta?.emission_factors_g_per_km || DEFAULT_EF;
              const countsByMode = {};
              let totalTrips = 0;
              if (precomputed && Array.isArray(precomputed.agents)) {
                for (const a of precomputed.agents) {
                  for (const leg of a.legs || []) {
                    const tEnd = leg.end_time ?? leg.path?.[leg.path.length - 1]?.t;
                    if (tEnd == null || tEnd > currentTime) continue; // only include completed trips up to current time
                    const m = String(leg.mode || a.mode || 'unknown').toLowerCase();
                    if (m === 'unknown') continue;
                    countsByMode[m] = (countsByMode[m] || 0) + 1;
                    totalTrips += 1;
                  }
                }
              }
              const modesAll = Object.keys(countsByMode);
              const base = MODE_ORDER;
              const extras = modesAll.filter((m) => !base.includes(m));
              const modes = [...base, ...extras];
              return modes.map((m) => {
                const cArr = pollutionColor(m, efMapForColors);
                const pct = totalTrips > 0 ? Math.round(((countsByMode[m] || 0) / totalTrips) * 100) : 0;
                return (
                  <div key={m} className="legend-item">
                    <span className="legend-dot" style={{ background: colorToCss(cArr) }} />
                    <span className="legend-label">{titleCaseFromMode(m)} · {pct}%</span>
                  </div>
                );
              });
            })()}
          </div>
        </div>
        {/* Scenario controls moved to topbar to keep right panel focused on statistics */}
        {scenarioName === 'carbon_credits' && (
          <div className={`panel-carbon${isCarbonCollapsed ? ' collapsed' : ''}`}>
            <div className="panel-carbon-header">
              <h3>Carbon Credits Leaderboard</h3>
              <button
                type="button"
                className="panel-toggle"
                onClick={() => setIsCarbonCollapsed((v) => !v)}
                aria-label={isCarbonCollapsed ? 'Expand leaderboard' : 'Collapse leaderboard'}
                title={isCarbonCollapsed ? 'Expand' : 'Collapse'}
              >
                {isCarbonCollapsed ? '▸' : '▾'}
              </button>
            </div>
            {!isCarbonCollapsed && (
              <>
                <div className="sub">Top 5 agents</div>
                <div className="leaderboard">
                  {(carbonLeaderboard || []).slice(0, 5).map((row, i) => {
                    const displayId = String(row.agentId || '').replace(/^GZ-/i, 'RESIDENT-');
                    return (
                      <div className="lb-row" key={row.agentId}>
                        <span className="lb-rank">{i + 1}</span>
                        <span className="lb-agent">{displayId}</span>
                        <span className="lb-score">{row.score.toFixed(1)} pts {row.delta > 0 ? <span className="lb-delta">+{row.delta.toFixed(1)}</span> : null}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      
    </div>
  );
}

export default App;