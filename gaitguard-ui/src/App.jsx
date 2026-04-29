import { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react'
import './App.css'

const SENSOR_LAYOUT = [
  { key: 'heel', label: 'Heel', pin: 'A0', description: 'Impact loading', uiX: 50, uiY: 72 },
  { key: 'arch', label: 'Arch', pin: 'A3', description: 'Midfoot support', uiX: 50, uiY: 48 },
  { key: 'bigToe', label: 'Big Toe', pin: 'A1', description: 'Push-off drive', uiX: 62, uiY: 18 },
  { key: 'smallToe', label: 'Small Toe', pin: 'A2', description: 'Lateral balance', uiX: 36, uiY: 26 },
]

const DEFAULT_API_URL = 'http://192.168.4.1'
const POLL_INTERVAL_MS = 250
const HISTORY_WINDOW_MS = 60000
const HISTORY_LIMIT = 320
const CONTACT_FORCE_THRESHOLD = 120

const EMPTY_TELEMETRY = {
  source: 'disconnected',
  apiUrl: DEFAULT_API_URL,
  fetchedAt: 0,
  latency: null,
  device: 'GaitGuard Solo',
  mode: 'paused',
  strikeThreshold: 0,
  sampleRateMs: POLL_INTERVAL_MS,
  uptimeMs: 0,
  fsr: { heel: 0, bigToe: 0, smallToe: 0, arch: 0 },
  cop: { x: 50, y: 50 },
  displayCop: { x: 50, y: 50, active: false },
  normalized: { heel: 0, bigToe: 0, smallToe: 0, arch: 0 },
  totals: { pressure: 0, forefoot: 0, rearfoot: 0 },
  metrics: { gaitScore: 0, impactRisk: 0, toeDrive: 0, archSupport: 0, stability: 0, balance: 50 },
  outputs: { motors: [0, 0, 0, 0], audioTrack: 0 },
  flags: { heelStrike: false, alertActive: false, audioEnabled: false },
  network: { ssid: 'GaitGuard_Live', ip: '192.168.4.1', clients: 0 },
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function formatPercent(value) {
  return `${Math.round(value)}%`
}

function formatLatency(value) {
  if (value == null) {
    return 'n/a'
  }

  return `${Math.round(value)} ms`
}

function formatUptime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

function average(values) {
  if (!values.length) {
    return 0
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function standardDeviation(values) {
  if (values.length < 2) {
    return 0
  }

  const mean = average(values)
  const variance = average(values.map((value) => (value - mean) ** 2))
  return Math.sqrt(variance)
}

function computeDisplayCop(fsr) {
  const points = SENSOR_LAYOUT.map((sensor) => ({
    x: sensor.uiX,
    y: sensor.uiY,
    weight: Math.max(0, fsr[sensor.key] ?? 0),
  }))
  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0)

  if (totalWeight < CONTACT_FORCE_THRESHOLD) {
    return {
      x: 50,
      y: 50,
      active: false,
    }
  }

  return {
    x: points.reduce((sum, point) => sum + point.x * point.weight, 0) / totalWeight,
    y: points.reduce((sum, point) => sum + point.y * point.weight, 0) / totalWeight,
    active: true,
  }
}

function computeMinuteAnalysis(history, telemetry) {
  const windowEnd = telemetry.fetchedAt
  const windowStart = windowEnd - HISTORY_WINDOW_MS
  const samples = history.filter((point) => point.timestamp >= windowStart)
  const activeSamples = samples.filter((point) => point.contact)
  const secondsCovered = samples.length > 1 ? (samples[samples.length - 1].timestamp - samples[0].timestamp) / 1000 : 0

  let estimatedSteps = 0
  for (let index = 1; index < samples.length; index += 1) {
    if (!samples[index - 1].contact && samples[index].contact) {
      estimatedSteps += 1
    }
  }

  const pronationFrames = activeSamples.filter((point) => point.displayCop.x > 53).length
  const supinationFrames = activeSamples.filter((point) => point.displayCop.x < 47).length

  const meanTotalLoad = average(activeSamples.map((point) => point.totalPressure))
  const peakTotalLoad = activeSamples.length
    ? Math.max(...activeSamples.map((point) => point.totalPressure))
    : 0
  const heelShare = average(activeSamples.map((point) => point.ratios.heel))
  const archShare = average(activeSamples.map((point) => point.ratios.arch))
  const toeShare = average(activeSamples.map((point) => point.ratios.toe))
  const lateralBias = average(activeSamples.map((point) => point.medialBias))
  const copSpread = standardDeviation(activeSamples.map((point) => point.displayCop.x))
  const copForwardDrift = average(activeSamples.map((point) => point.displayCop.y))
  const pronationRatio = activeSamples.length ? pronationFrames / activeSamples.length : 0
  const supinationRatio = activeSamples.length ? supinationFrames / activeSamples.length : 0
  const cadence = secondsCovered > 8 ? (estimatedSteps / secondsCovered) * 60 : 0

  const stabilityScore = Math.round(
    clamp(
      100 -
        Math.abs(lateralBias) * 180 -
        copSpread * 6 -
        Math.max(0, heelShare - 0.46) * 70 -
        Math.max(0, 0.12 - archShare) * 120,
      18,
      96,
    ),
  )

  let profile = 'Neutral loading'
  if (pronationRatio > 0.58 && lateralBias > 0.08) {
    profile = 'Medial loading bias'
  } else if (supinationRatio > 0.58 && lateralBias < -0.08) {
    profile = 'Lateral loading bias'
  } else if (heelShare > 0.5) {
    profile = 'Rearfoot dominant loading'
  }

  const insights = []

  if (!activeSamples.length) {
    insights.push({
      tone: 'neutral',
      title: 'Waiting for contact',
      body: 'The one-minute buffer is ready. Press or walk on the sole to build a stable gait profile.',
    })
  } else {
    if (pronationRatio > 0.58 && lateralBias > 0.08) {
      insights.push({
        tone: 'warning',
        title: 'Possible pronation tendency',
        body: 'The pressure centroid spends most of the active window toward the medial side, which can reflect a pronation-style loading bias.',
      })
    }

    if (supinationRatio > 0.58 && lateralBias < -0.08) {
      insights.push({
        tone: 'warning',
        title: 'Possible supination tendency',
        body: 'The pressure centroid stays mostly lateral in the active window, which can indicate outward loading or reduced medial transfer.',
      })
    }

    if (heelShare > 0.5 && toeShare < 0.32) {
      insights.push({
        tone: 'critical',
        title: 'Heel-dominant landing',
        body: 'Heel loading is persistently high relative to forefoot drive, suggesting a harsher initial contact and weaker push-off pattern.',
      })
    }

    if (archShare < 0.1) {
      insights.push({
        tone: 'warning',
        title: 'Low midfoot engagement',
        body: 'Midfoot loading stays light across the minute buffer, which may reflect limited arch participation or sensor placement too far from the load path.',
      })
    }

    if (copSpread > 4.8) {
      insights.push({
        tone: 'warning',
        title: 'High lateral variability',
        body: 'The center of pressure wanders laterally more than expected, which can signal balance inconsistency or unstable stance transitions.',
      })
    }

    if (stabilityScore > 78 && Math.abs(lateralBias) < 0.07) {
      insights.push({
        tone: 'positive',
        title: 'Balanced pressure transfer',
        body: 'The rolling window shows a fairly centered pressure path with controlled load transfer, which is ideal for the live judge demo.',
      })
    }
  }

  return {
    secondsCovered,
    sampleCount: samples.length,
    activeSamples: activeSamples.length,
    estimatedSteps,
    cadence,
    meanTotalLoad,
    peakTotalLoad,
    heelShare,
    archShare,
    toeShare,
    lateralBias,
    copSpread,
    copForwardDrift,
    pronationRatio,
    supinationRatio,
    stabilityScore,
    profile,
    insights: insights.slice(0, 4),
  }
}

function buildSimulationFrame(timestamp) {
  const t = timestamp / 1000
  const heel = clamp(Math.round(480 + Math.sin(t * 2.15) * 180 + Math.cos(t * 0.55) * 60), 90, 920)
  const bigToe = clamp(Math.round(290 + Math.sin(t * 2.15 + 1.45) * 150 + Math.sin(t * 0.45) * 35), 40, 860)
  const smallToe = clamp(Math.round(220 + Math.sin(t * 2.15 + 2.25) * 120 + Math.cos(t * 0.95) * 30), 35, 790)
  const arch = clamp(Math.round(160 + Math.cos(t * 1.3) * 70 + Math.sin(t * 0.65) * 25), 20, 500)
  const heelStrike = heel > 650 && bigToe < 240

  return {
    device: 'GaitGuard Solo',
    mode: heelStrike ? 'correction' : 'analysis',
    strikeThreshold: 600,
    sampleRateMs: 120,
    uptimeMs: Math.floor(timestamp),
    fsr: { heel, bigToe, smallToe, arch },
    outputs: {
      motors: [heelStrike ? 200 : 0, 0, 0, 0],
      audioTrack: heelStrike ? 2 : 0,
    },
    flags: {
      heelStrike,
      alertActive: heelStrike,
      audioEnabled: true,
    },
    network: {
      ssid: 'GaitGuard_Demo',
      ip: '192.168.4.1',
      clients: 1,
    },
  }
}

async function fetchTelemetrySnapshot(apiUrl) {
  const endpointCandidates = [`${apiUrl}/api/telemetry`, apiUrl]
  let lastError = null

  for (const endpoint of endpointCandidates) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('application/json')) {
        throw new Error('Endpoint did not return JSON')
      }

      return response.json()
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unable to reach telemetry endpoint')
}

function normalizeTelemetry(raw, source, latency, apiUrl) {
  const legacyPayload = raw && ('F1' in raw || 'F2' in raw || 'F3' in raw || 'F4' in raw)
  const fsrSource = raw?.fsr ?? raw?.sensors ?? raw ?? {}
  const heel = toNumber(fsrSource.heel ?? raw?.heel ?? raw?.F1)
  const bigToe = toNumber(fsrSource.bigToe ?? raw?.bigToe ?? raw?.F2)
  const smallToe = toNumber(fsrSource.smallToe ?? raw?.smallToe ?? raw?.F3)
  const arch = toNumber(fsrSource.arch ?? raw?.arch ?? raw?.F4)
  const copX = toNumber(raw?.CoPX ?? raw?.copX, 150)
  const copY = toNumber(raw?.CoPY ?? raw?.copY, 250)
  const normalizationReference = Math.max(600, heel, bigToe, smallToe, arch)

  const normalized = raw?.normalized ?? {
    heel: Math.round((heel / normalizationReference) * 100),
    bigToe: Math.round((bigToe / normalizationReference) * 100),
    smallToe: Math.round((smallToe / normalizationReference) * 100),
    arch: Math.round((arch / normalizationReference) * 100),
  }

  const totalPressure = heel + bigToe + smallToe + arch
  const forefoot = bigToe + smallToe
  const rearfoot = heel + arch
  const displayCop = computeDisplayCop({ heel, bigToe, smallToe, arch })
  const heelRatio = totalPressure > 0 ? heel / totalPressure : 0
  const toeRatio = totalPressure > 0 ? forefoot / totalPressure : 0
  const archRatio = totalPressure > 0 ? arch / totalPressure : 0
  const spreadPenalty = Math.abs(normalized.bigToe - normalized.smallToe) / 100
  const impactRisk = clamp(heelRatio * 1.35 - toeRatio * 0.42, 0, 1)
  const stability = clamp(1 - spreadPenalty - impactRisk * 0.25, 0, 1)
  const balance = clamp(50 + (normalized.bigToe - normalized.smallToe) * 0.55, 0, 100)
  const gaitScore = Math.round(
    clamp(
      100 - impactRisk * 52 - Math.abs(55 - balance) * 0.38 - Math.max(0, 28 - normalized.arch) * 0.6,
      24,
      97,
    ),
  )

  return {
    source,
    apiUrl,
    fetchedAt: Date.now(),
    latency,
    device: raw?.device ?? 'GaitGuard Solo',
    mode: raw?.mode ?? 'analysis',
    strikeThreshold: toNumber(raw?.strikeThreshold, 600),
    sampleRateMs: toNumber(raw?.sampleRateMs, 150),
    uptimeMs: toNumber(raw?.uptimeMs ?? raw?.uptime, 0),
    fsr: { heel, bigToe, smallToe, arch },
    cop: { x: copX, y: copY },
    displayCop,
    normalized: {
      heel: clamp(toNumber(normalized.heel), 0, 100),
      bigToe: clamp(toNumber(normalized.bigToe), 0, 100),
      smallToe: clamp(toNumber(normalized.smallToe), 0, 100),
      arch: clamp(toNumber(normalized.arch), 0, 100),
    },
    totals: {
      pressure: totalPressure,
      forefoot,
      rearfoot,
    },
    metrics: {
      gaitScore,
      impactRisk,
      toeDrive: toeRatio,
      archSupport: archRatio,
      stability,
      balance,
    },
    outputs: {
      motors: Array.isArray(raw?.outputs?.motors)
        ? raw.outputs.motors
        : [
            heel > 0 && displayCop.y > 60 ? 150 : 0,
            displayCop.x > 53 ? 150 : 0,
            displayCop.x < 47 ? 150 : 0,
            arch > 0 && arch < heel * 0.25 ? 90 : 0,
          ],
      audioTrack: toNumber(raw?.outputs?.audioTrack, 0),
    },
    flags: {
      heelStrike: Boolean(raw?.flags?.heelStrike ?? (heel > 350 && bigToe < 180)),
      alertActive: Boolean(raw?.flags?.alertActive ?? (displayCop.active && (displayCop.x < 47 || displayCop.x > 53))),
      audioEnabled: Boolean(raw?.flags?.audioEnabled ?? true),
    },
    network: {
      ssid: raw?.network?.ssid ?? (legacyPayload ? 'GaitGuard_Live' : 'GaitGuard_Demo'),
      ip: raw?.network?.ip ?? apiUrl.replace('http://', '').replace('https://', ''),
      clients: toNumber(raw?.network?.clients, 0),
    },
  }
}

function buildPolyline(history) {
  if (!history.length) {
    return ''
  }

  const width = 620
  const height = 220
  const maxPressure = Math.max(...history.map((point) => point.totalPressure), 1)

  return history
    .map((point, index) => {
      const x = history.length === 1 ? 0 : (index / (history.length - 1)) * width
      const y = height - (point.totalPressure / maxPressure) * (height - 18) - 8
      return `${x},${y}`
    })
    .join(' ')
}

function buildInsights(telemetry) {
  const insights = []

  if (telemetry.metrics.impactRisk > 0.58) {
    insights.push('Heel strike is landing too aggressively. Soften the first contact and shift load forward sooner.')
  }

  if (telemetry.metrics.toeDrive < 0.3) {
    insights.push('Toe engagement is underpowered. Use the forefoot later in the step to improve propulsion.')
  }

  if (telemetry.metrics.archSupport < 0.16) {
    insights.push('Arch loading is light. Check sole placement and confirm the sensor sits under the midfoot.')
  }

  if (telemetry.metrics.stability > 0.72) {
    insights.push('Pressure distribution looks stable enough for a strong demo. This is the moment to show judges the live map.')
  }

  return insights.slice(0, 3)
}

function App() {
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem('gaitguard.apiUrl') ?? DEFAULT_API_URL)
  const [telemetry, setTelemetry] = useState(null)
  const [history, setHistory] = useState([])
  const [events, setEvents] = useState([
    {
      id: 1,
      title: 'Dashboard primed',
      body: 'Waiting for live telemetry from the Arduino.',
      tone: 'neutral',
      timestamp: Date.now(),
    },
  ])
  const [connection, setConnection] = useState({
    state: 'booting',
    source: 'disconnected',
    latency: null,
    error: '',
  })
  const [busyCommand, setBusyCommand] = useState('')
  const [refreshSeed, setRefreshSeed] = useState(0)
  const [showDetails, setShowDetails] = useState(false)
  const eventCounterRef = useRef(2)
  const previousRef = useRef({
    alertActive: false,
    mode: 'paused',
    source: 'disconnected',
  })

  const deferredHistory = useDeferredValue(history)

  useEffect(() => {
    localStorage.setItem('gaitguard.apiUrl', apiUrl)
  }, [apiUrl])

  useEffect(() => {
    let cancelled = false

    const pushEvent = (title, body, tone = 'neutral') => {
      const nextEvent = {
        id: eventCounterRef.current++,
        title,
        body,
        tone,
        timestamp: Date.now(),
      }

      setEvents((current) => [nextEvent, ...current].slice(0, 6))
    }

    const applyFrame = (frame, source, latency, errorMessage = '') => {
      if (cancelled) {
        return
      }

      const nextTelemetry = normalizeTelemetry(frame, source, latency, apiUrl)
      const previous = previousRef.current

      setTelemetry(nextTelemetry)
      setConnection({
        state: errorMessage ? 'degraded' : 'live',
        source,
        latency,
        error: errorMessage,
      })

      startTransition(() => {
        setHistory((current) => [
          ...current,
          {
            id: nextTelemetry.fetchedAt,
            timestamp: nextTelemetry.fetchedAt,
            totalPressure: nextTelemetry.totals.pressure,
            heel: nextTelemetry.fsr.heel,
            toe: nextTelemetry.totals.forefoot,
            arch: nextTelemetry.fsr.arch,
            medialBias:
              nextTelemetry.totals.forefoot > 0
                ? (nextTelemetry.fsr.bigToe - nextTelemetry.fsr.smallToe) / nextTelemetry.totals.forefoot
                : 0,
            ratios: {
              heel: nextTelemetry.totals.pressure > 0 ? nextTelemetry.fsr.heel / nextTelemetry.totals.pressure : 0,
              arch: nextTelemetry.totals.pressure > 0 ? nextTelemetry.fsr.arch / nextTelemetry.totals.pressure : 0,
              toe: nextTelemetry.totals.pressure > 0 ? nextTelemetry.totals.forefoot / nextTelemetry.totals.pressure : 0,
            },
            displayCop: nextTelemetry.displayCop,
            contact: nextTelemetry.totals.pressure >= CONTACT_FORCE_THRESHOLD,
          },
        ]
          .filter((point) => nextTelemetry.fetchedAt - point.timestamp <= HISTORY_WINDOW_MS)
          .slice(-HISTORY_LIMIT))
      })

      if (nextTelemetry.flags.alertActive && !previous.alertActive) {
        pushEvent(
          'Impact alert fired',
          'Heel pressure exceeded the strike threshold while toe loading stayed low.',
          'critical',
        )
      }

      if (nextTelemetry.mode !== previous.mode) {
        pushEvent(
          'Mode changed',
          `The firmware switched into ${nextTelemetry.mode} mode.`,
          'neutral',
        )
      }

      if (source !== previous.source) {
        pushEvent(
          source === 'arduino' ? 'Arduino feed restored' : 'Telemetry unavailable',
          source === 'arduino'
            ? 'Live telemetry is now streaming from the Uno R4 API.'
            : 'The dashboard is waiting for a real JSON response from the board.',
          source === 'arduino' ? 'positive' : 'warning',
        )
      }

      previousRef.current = {
        alertActive: nextTelemetry.flags.alertActive,
        mode: nextTelemetry.mode,
        source,
      }
    }

    async function readTelemetry() {
      const startedAt = performance.now()

      try {
        const payload = await fetchTelemetrySnapshot(apiUrl)
        applyFrame(payload, 'arduino', performance.now() - startedAt)
      } catch (error) {
        if (!cancelled) {
          setConnection({
            state: 'degraded',
            source: 'disconnected',
            latency: null,
            error: error instanceof Error ? error.message : 'Unable to reach device',
          })

          if (!telemetry) {
            setHistory([])
          }
        }
      }
    }

    readTelemetry()
    const interval = window.setInterval(readTelemetry, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [apiUrl, refreshSeed])

  async function sendCommand(path, loadingLabel, optimisticMode) {
    setBusyCommand(loadingLabel)

    try {
      setConnection((current) => ({
        ...current,
        state: 'live',
        error: '',
      }))

      if (optimisticMode) {
        setTelemetry((current) => ({ ...current, mode: optimisticMode }))
      }

      setEvents((current) => [
        {
          id: eventCounterRef.current++,
          title: loadingLabel,
          body: 'Dashboard-only action applied. This firmware build does not expose control endpoints.',
          tone: 'positive',
          timestamp: Date.now(),
        },
        ...current,
      ].slice(0, 6))
    } catch (error) {
      setEvents((current) => [
        {
          id: eventCounterRef.current++,
          title: `${loadingLabel} failed`,
          body:
            error instanceof Error
              ? `The board did not confirm the command: ${error.message}.`
              : 'The board did not confirm the command.',
          tone: 'critical',
          timestamp: Date.now(),
        },
        ...current,
      ].slice(0, 6))
    } finally {
      setBusyCommand('')
      setRefreshSeed((current) => current + 1)
    }
  }

  const currentTelemetry = telemetry ?? EMPTY_TELEMETRY
  const solePoints = SENSOR_LAYOUT.map((sensor) => ({
    ...sensor,
    raw: currentTelemetry.fsr[sensor.key],
    level: currentTelemetry.normalized[sensor.key],
  }))
  const chartPoints = buildPolyline(deferredHistory)
  const minuteAnalysis = computeMinuteAnalysis(deferredHistory, currentTelemetry)
  const insights = telemetry ? buildInsights(currentTelemetry) : []
  const activeMotors = currentTelemetry.outputs.motors.filter((value) => value > 0).length
  const liveLabel = connection.source === 'arduino' ? 'Live Arduino Feed' : 'Waiting For Device'
  const scoreStyle = {
    '--score-angle': `${(currentTelemetry.metrics.gaitScore / 100) * 360}deg`,
  }
  const copLeft = `${currentTelemetry.displayCop.x}%`
  const copTop = `${currentTelemetry.displayCop.y}%`
  const contactLabel = !telemetry
    ? 'Waiting'
    : currentTelemetry.displayCop.active
      ? 'Foot detected'
      : 'No pressure'
  const balanceLabel = !telemetry || !currentTelemetry.displayCop.active
    ? 'Centered'
    : currentTelemetry.displayCop.x < 47
      ? 'Leaning left'
      : currentTelemetry.displayCop.x > 53
        ? 'Leaning right'
        : 'Well balanced'
  const guidanceText = !telemetry
    ? 'Open the side menu only if you need connection settings. The main screen stays simple for the demo.'
    : currentTelemetry.flags.alertActive
      ? 'The system has detected an imbalance and is ready to guide the next step.'
      : 'Pressure is reading cleanly. This is a good state to show judges the live sole map.'
  const eventPreview = events.slice(0, 3)

  return (
    <main className="dashboard-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <section className="hero-panel panel">
        <div className="hero-copy">
          <div className="eyebrow-row">
            <span className="eyebrow">Student Innovation Prototype</span>
            <div className="topbar-actions">
              <span className={`status-pill status-${connection.source}`}>
                <span className="status-dot" />
                {liveLabel}
              </span>
              <button className="ghost-button compact-button" onClick={() => setShowDetails(true)}>
                System menu
              </button>
            </div>
          </div>

          <h1>GaitGuard Live</h1>
          <p className="hero-text">
            A cleaner live view of pressure, balance, and movement for your single-sole prototype.
          </p>

          <div className="hero-actions">
            <button className="primary-button" onClick={() => setRefreshSeed((current) => current + 1)}>
              Refresh
            </button>
            <span className="inline-note">{guidanceText}</span>
          </div>

          <div className="hero-stats hero-highlights">
            <div>
              <span className="stat-label">Current load</span>
              <strong>{telemetry ? currentTelemetry.totals.pressure : '--'}</strong>
            </div>
            <div>
              <span className="stat-label">Balance</span>
              <strong>{balanceLabel}</strong>
            </div>
            <div>
              <span className="stat-label">Contact</span>
              <strong>{contactLabel}</strong>
            </div>
            <div>
              <span className="stat-label">Steps</span>
              <strong>{minuteAnalysis.estimatedSteps}</strong>
            </div>
          </div>
        </div>

        <div className="score-card">
          <div className="score-ring" style={scoreStyle}>
            <div className="score-center">
              <span>Gait score</span>
              <strong>{currentTelemetry.metrics.gaitScore || '--'}</strong>
            </div>
          </div>

          <div className="score-details">
            <div>
              <span className="stat-label">Impact risk</span>
              <strong>{telemetry ? formatPercent(currentTelemetry.metrics.impactRisk * 100) : '--'}</strong>
            </div>
            <div>
              <span className="stat-label">Toe drive</span>
              <strong>{telemetry ? formatPercent(currentTelemetry.metrics.toeDrive * 100) : '--'}</strong>
            </div>
            <div>
              <span className="stat-label">Stability</span>
              <strong>{telemetry ? formatPercent(currentTelemetry.metrics.stability * 100) : '--'}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="dashboard-grid dashboard-grid-clean">
        <article className="panel sole-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Pressure map</p>
              <h2>Live single-sole footprint</h2>
            </div>
            <span className="panel-chip">4 FSR sensors</span>
          </div>

          <div className="sole-stage">
            <div className="sole-shape">
              {solePoints.map((point) => (
                <div
                  key={point.key}
                  className={`pressure-node node-${point.key}`}
                  style={{ '--pressure-scale': 0.78 + point.level / 105, '--pressure-alpha': 0.2 + point.level / 125 }}
                >
                <span>{point.label}</span>
                  <strong>{telemetry ? point.level : '--'}</strong>
                  <small>{point.pin}</small>
                </div>
              ))}
              <div className="cop-marker" style={{ left: copLeft, top: copTop }}>
                <span>CoP</span>
              </div>
            </div>
          </div>

          <div className="sensor-grid">
            {solePoints.map((point) => (
              <div key={point.key} className="sensor-card">
                <div className="sensor-head">
                  <div>
                    <p>{point.label}</p>
                    <span>{point.description}</span>
                  </div>
                  <strong>{telemetry ? point.raw : '--'}</strong>
                </div>
                <div className="meter-track">
                  <div className="meter-fill" style={{ width: `${point.level}%` }} />
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="summary-panel panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Live summary</p>
              <h2>What to notice</h2>
            </div>
            <span className="panel-chip">{telemetry ? 'Live' : 'Standby'}</span>
          </div>

          <div className="summary-layout">
            <div className="system-grid summary-metrics">
              <div className="system-card">
                <span className="stat-label">Rearfoot load</span>
                <strong>{telemetry ? currentTelemetry.totals.rearfoot : '--'}</strong>
                <p>Heel and midfoot pressure</p>
              </div>
              <div className="system-card">
                <span className="stat-label">Forefoot load</span>
                <strong>{telemetry ? currentTelemetry.totals.forefoot : '--'}</strong>
                <p>Toe area pressure</p>
              </div>
              <div className="system-card">
                <span className="stat-label">Center point</span>
                <strong>{currentTelemetry.displayCop.x.toFixed(1)}, {currentTelemetry.displayCop.y.toFixed(1)}</strong>
                <p>{currentTelemetry.displayCop.active ? 'Live weighted position' : 'Centered while idle'}</p>
              </div>
              <div className="system-card">
                <span className="stat-label">Monitoring</span>
                <strong>{connection.source === 'arduino' ? 'Connected' : 'Waiting'}</strong>
                <p>{telemetry ? 'Data is updating live' : 'No confirmed telemetry yet'}</p>
              </div>
            </div>

            <div className="summary-bottom">
              <div className="load-bars">
                <div className="load-row">
                  <span>Heel</span>
                  <div className="meter-track"><div className="meter-fill" style={{ width: `${currentTelemetry.normalized.heel}%` }} /></div>
                  <strong>{telemetry ? currentTelemetry.normalized.heel : '--'}</strong>
                </div>
                <div className="load-row">
                  <span>Arch</span>
                  <div className="meter-track"><div className="meter-fill" style={{ width: `${currentTelemetry.normalized.arch}%` }} /></div>
                  <strong>{telemetry ? currentTelemetry.normalized.arch : '--'}</strong>
                </div>
                <div className="load-row">
                  <span>Big toe</span>
                  <div className="meter-track"><div className="meter-fill" style={{ width: `${currentTelemetry.normalized.bigToe}%` }} /></div>
                  <strong>{telemetry ? currentTelemetry.normalized.bigToe : '--'}</strong>
                </div>
                <div className="load-row">
                  <span>Small toe</span>
                  <div className="meter-track"><div className="meter-fill" style={{ width: `${currentTelemetry.normalized.smallToe}%` }} /></div>
                  <strong>{telemetry ? currentTelemetry.normalized.smallToe : '--'}</strong>
                </div>
              </div>

              <div className="mini-chart-card mini-activity-card">
                <div className="mini-chart-header">
                  <div>
                    <p className="panel-kicker">Recent updates</p>
                    <h3>Latest activity</h3>
                  </div>
                  <span className="panel-chip">{eventPreview.length} shown</span>
                </div>
                <div className="event-list compact-event-list">
                  {eventPreview.map((event) => (
                    <div key={event.id} className={`event-card tone-${event.tone}`}>
                      <div className="event-title-row">
                        <strong>{event.title}</strong>
                        <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
                      </div>
                      <p>{event.body}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="status-banner compact-banner">
              <strong>{!telemetry ? 'Ready when the sole connects' : currentTelemetry.flags.alertActive ? 'Guidance active' : 'Reading looks stable'}</strong>
              <p>
                {!telemetry
                  ? 'No random demo numbers are shown now. The screen waits for the real Arduino feed.'
                  : currentTelemetry.flags.alertActive
                    ? 'The sole is detecting a shift that may need correction.'
                    : 'The live reading is clean and easy to present.'}
              </p>
            </div>
          </div>
        </article>

        <article className="panel events-panel events-panel-slim">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Activity</p>
              <h2>Pressure pulse</h2>
            </div>
            <span className="panel-chip">{deferredHistory.length} frames</span>
          </div>

          <div className="timeline-shell">
            <svg viewBox="0 0 620 220" className="timeline-svg" role="img" aria-label="Pressure history chart">
              <defs>
                <linearGradient id="waveStrokeLarge" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#4fd1c5" />
                  <stop offset="50%" stopColor="#f7b267" />
                  <stop offset="100%" stopColor="#ff6b6b" />
                </linearGradient>
              </defs>
              <path d="M0 210 H620" className="baseline" />
              {chartPoints ? (
                <polyline
                  fill="none"
                  stroke="url(#waveStrokeLarge)"
                  strokeWidth="5"
                  points={chartPoints}
                  strokeLinecap="round"
                />
              ) : null}
            </svg>

            <div className="timeline-footer compact-stats">
              <div>
                <span className="stat-label">Load</span>
                <strong>{telemetry ? currentTelemetry.totals.pressure : '--'}</strong>
              </div>
              <div>
                <span className="stat-label">Steps</span>
                <strong>{minuteAnalysis.estimatedSteps}</strong>
              </div>
              <div>
                <span className="stat-label">Motors</span>
                <strong>{activeMotors}/4</strong>
              </div>
              <div>
                <span className="stat-label">Audio</span>
                <strong>{currentTelemetry.outputs.audioTrack || 'idle'}</strong>
              </div>
            </div>
          </div>

          {connection.error ? <p className="error-text">Last API issue: {connection.error}</p> : null}
        </article>
      </section>

      <div className={`drawer-scrim ${showDetails ? 'open' : ''}`} onClick={() => setShowDetails(false)} />
      <aside className={`details-drawer ${showDetails ? 'open' : ''}`}>
        <div className="drawer-header">
          <div>
            <p className="panel-kicker">System menu</p>
            <h2>Connection details</h2>
          </div>
          <button className="ghost-button compact-button" onClick={() => setShowDetails(false)}>
            Close
          </button>
        </div>

        <label className="control-block">
          <span>Arduino API URL</span>
          <input
            className="url-input"
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
            placeholder="http://192.168.4.1"
          />
        </label>

        <div className="control-actions drawer-actions">
          <button
            className="primary-button"
            onClick={() => sendCommand('', 'Reconnect panel', undefined)}
            disabled={busyCommand.length > 0}
          >
            {busyCommand === 'Reconnect panel' ? 'Refreshing...' : 'Reconnect'}
          </button>
          <button className="ghost-button" onClick={() => setRefreshSeed((current) => current + 1)}>
            Poll now
          </button>
        </div>

        <div className="system-grid drawer-grid">
          <div className="system-card">
            <span className="stat-label">Status</span>
            <strong>{connection.state}</strong>
            <p>{connection.error || 'Connection looks healthy'}</p>
          </div>
          <div className="system-card">
            <span className="stat-label">WiFi AP</span>
            <strong>{currentTelemetry.network.ssid}</strong>
            <p>{currentTelemetry.network.ip}</p>
          </div>
          <div className="system-card">
            <span className="stat-label">Latency</span>
            <strong>{formatLatency(connection.latency)}</strong>
            <p>{currentTelemetry.sampleRateMs} ms polling window</p>
          </div>
          <div className="system-card">
            <span className="stat-label">Audio</span>
            <strong>{currentTelemetry.outputs.audioTrack || 'idle'}</strong>
            <p>Most recent DFPlayer track</p>
          </div>
        </div>
      </aside>
    </main>
  )
}

export default App
