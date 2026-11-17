import { MODULE_BY_KEY } from '@/data/modules'
import {
  clearChartRefreshState,
  listRows,
  rereadChartRefreshState,
  saveChartRefreshState,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  ChartRefreshArchive,
  ChartRefreshDetailView,
  ChartRefreshOverview,
  ChartRefreshReuseEvent,
  ChartRefreshState,
  ChartRefreshSummary,
  ChartScheduleState,
  ChartScheduleView,
  ChartSnapshot,
  ChartSourceVersionView,
  EntryRow,
} from '@/data/types'

/**
 * 图表刷新引擎。
 *
 * 调用链：页面 -> api/local-service.ts -> api/chart-refresh.ts -> data/local-store.ts。
 * 唯一的写入点是本文件的 persist()；图表刷新结果字段明细（含版本、窗口、坐标）只从这里落盘。
 *
 * 复用规则：坐标（数据来源 + X 轴字段 + Y 轴字段）相同、时间窗口相同、数据源版本相同的
 * 到期请求合并成一个分组，只计算一次聚合，其余图表复用同一份字段明细。
 */

const CHART_KEY = 'chart'
const STATE_VERSION = 2
const MIN_INTERVAL_SECONDS = 5
const MAX_INTERVAL_SECONDS = 86_400

export const CHART_REFRESH_NAME = '图表刷新结果字段明细'

/** 列表/筛选/导出共用的字段顺序，改这里即可同时影响三者。 */
export const CHART_REFRESH_FIELDS = [
  '明细编号',
  '图表编号',
  '数据来源',
  '坐标值',
  '时间窗口',
  '数据源版本',
  '明细版本',
  '复用次数',
  '结果值',
  '刷新时刻',
]

/** 支持检索的目标字段：列表里逐列可筛。 */
export const CHART_REFRESH_FILTER_FIELDS = [
  '明细编号',
  '图表编号',
  '数据来源',
  '坐标值',
  '时间窗口',
  '数据源版本',
  '明细版本',
  '复用次数',
  '结果值',
]

let inFlight = false

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function text(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

function chartRows(): EntryRow[] {
  return listRows(CHART_KEY)
}

function chartNoOf(row: EntryRow): string {
  return text(row, '图表编号') || `CHAR-${pad(Number(row.id) || 0, 4)}`
}

function sourceOf(row: EntryRow): string {
  return text(row, '数据来源') || '未命名数据源'
}

function intervalOf(row: EntryRow): number {
  const parsed = Number(text(row, '刷新间隔秒'))
  if (!Number.isFinite(parsed)) {
    return 60
  }
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.floor(parsed)))
}

/** 坐标维度：数据来源 + X 轴字段 + Y 轴字段。 */
function coordinateOf(row: EntryRow): string {
  return [
    `数据来源=${sourceOf(row)}`,
    `X轴=${text(row, 'X轴字段') || '—'}`,
    `Y轴=${text(row, 'Y轴字段') || '—'}`,
  ].join('；')
}

function coordinateKeyOf(row: EntryRow): string {
  return [sourceOf(row), text(row, 'X轴字段'), text(row, 'Y轴字段')].join('|')
}

function formatWindow(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)} ${pad(
    date.getHours(),
    2,
  )}:${pad(date.getMinutes(), 2)}`
}

function formatClock(at: number): string {
  const date = new Date(at)
  return `${formatWindow(at)}:${pad(date.getSeconds(), 2)}`
}

/** 统一存本地时间字符串（YYYY-MM-DD HH:mm:ss）：窗口、刷新时刻和归档时间的展示口径一致。 */
function isoAt(at: number): string {
  const date = new Date(at)
  return `${formatWindow(at)}:${pad(date.getSeconds(), 2)}`
}

function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function hash(input: string): number {
  let value = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

/** 模拟一次聚合：同一坐标 + 同一窗口 + 同一数据源版本必须得到同一结果。 */
function aggregate(
  source: string,
  coordinate: string,
  window: string,
  sourceVersion: number,
  yAxis: string,
): string {
  const seed = hash(`${source}|${coordinate}|${window}|v${sourceVersion}`)
  const groups = 3 + (seed % 5)
  const total = 1200 + (seed % 88_000)
  return `${groups} 组 · ${yAxis || '指标'}合计 ${grouped(total)}`
}

function emptyState(): ChartRefreshState {
  return {
    stateVersion: STATE_VERSION,
    sourceVersions: {},
    charts: {},
    archives: {},
    detailSeq: 0,
    batchSeq: 0,
    lastWindow: '',
    lastBatchId: '',
  }
}

function createSchedule(row: EntryRow, now: number, sourceVersion: number): ChartScheduleState {
  const intervalSeconds = intervalOf(row)
  return {
    intervalSeconds,
    nextDueAt: now + intervalSeconds * 1000,
    lastRefreshAt: null,
    displayed: null,
    scheduledVersion: sourceVersion,
    lastIntervalChangeAt: null,
  }
}

function loadState(now: number): ChartRefreshState {
  // 每次都从存储重读：多标签页/并发调用时，宁可看到最新已落盘的一份，也不拿旧内存覆盖。
  const stored = rereadChartRefreshState<ChartRefreshState>()
  if (!stored || stored.stateVersion !== STATE_VERSION) {
    const state = emptyState()
    syncCharts(state, now)
    persist(state)
    return state
  }
  let changed = false
  for (const archive of Object.values(stored.archives)) {
    // 兼容手改/截断的旧文件：缺字段时给出合法空值，避免界面读到 undefined。
    if (!Array.isArray(archive.chartConfigs)) {
      archive.chartConfigs = []
      changed = true
    }
    if (!Array.isArray(archive.chartSnapshots)) {
      archive.chartSnapshots = []
      changed = true
    }
    if (!Array.isArray(archive.reuseEvents)) {
      archive.reuseEvents = []
      changed = true
    }
    if (!Array.isArray(archive.chartNos)) {
      archive.chartNos = [...new Set(archive.chartSnapshots.map((item) => item.chartNo))]
      changed = true
    }
    if (typeof archive.reuseCount !== 'number') {
      archive.reuseCount = Math.max(0, archive.reuseEvents.length - 1)
      changed = true
    }
    if (!archive.window) {
      archive.window = stored.lastWindow || formatWindow(now)
      changed = true
    }
  }
  if (changed) {
    persist(stored)
  }
  return stored
}

/**
 * 唯一落盘口：明细的版本、窗口、归档快照一起写入本地文件。
 *
 * 落盘前先把存储里的最新一份合并进来（多标签页并发时后写的一份不能覆盖先写的）：
 * - 同一条明细被并发更新：按批次合并复用记录，保留先落盘的那份仓储；
 * - 两边各自分配了相同明细编号但坐标不同：后写的一方重新编号，绝不错并；
 * - 最后按「坐标 + 窗口 + 版本」去重，同一分组只认可一份明细。
 */
function persist(state: ChartRefreshState): void {
  const latest = rereadChartRefreshState<ChartRefreshState>()
  if (latest && latest.stateVersion === STATE_VERSION) {
    state.detailSeq = Math.max(state.detailSeq, latest.detailSeq)
    state.batchSeq = Math.max(state.batchSeq, latest.batchSeq)
    const latestByCode = new Map<string, ChartRefreshArchive>()
    for (const archive of Object.values(latest.archives)) {
      latestByCode.set(archive.detailCode, archive)
    }
    for (const archive of Object.values(state.archives)) {
      const other = latestByCode.get(archive.detailCode)
      if (!other) {
        continue
      }
      if (detailKey(other.coordinateKey, other.window, other.sourceVersion) ===
        detailKey(archive.coordinateKey, archive.window, archive.sourceVersion)) {
        if (other.updatedAt > archive.updatedAt) {
          mergeSameArchive(archive, other)
        }
        continue
      }
      // 明细编号撞车但分组不同：给本批这份换一个新编号，避免把两条明细错并成一条。
      delete state.archives[archive.detailCode]
      const oldCode = archive.detailCode
      let newCode = ''
      do {
        state.detailSeq += 1
        newCode = `CRFD-${pad(state.detailSeq, 4)}`
      } while (state.archives[newCode] || latestByCode.has(newCode))
      remapDisplayedCode(state, oldCode, newCode, archive.detailVersion)
      archive.detailCode = newCode
      archive.detailId = state.detailSeq
      for (const snapshot of archive.chartSnapshots) {
        snapshot.detailCode = newCode
      }
      state.archives[newCode] = archive
    }
    for (const [detailCode, archive] of Object.entries(latest.archives)) {
      if (!state.archives[detailCode]) {
        state.archives[detailCode] = archive
      }
    }
    // 另一标签页新登记的图表也要接进调度，已展示快照优先保留本批结果。
    for (const [chartNo, other] of Object.entries(latest.charts)) {
      const mine = state.charts[chartNo]
      if (!mine) {
        state.charts[chartNo] = other
        continue
      }
      if (other.lastRefreshAt && other.lastRefreshAt > (mine.lastRefreshAt ?? 0)) {
        state.charts[chartNo] = { ...other, displayed: mine.displayed ?? other.displayed }
      }
    }
  }
  dedupeArchives(state)
  saveChartRefreshState(clone(state))
}

/** 明细换编号时，把已展示快照和归档快照里的引用一起改掉，避免指向不存在的明细。 */
function remapDisplayedCode(
  state: ChartRefreshState,
  oldCode: string,
  newCode: string,
  detailVersion: string,
): void {
  for (const schedule of Object.values(state.charts)) {
    if (schedule.displayed?.detailCode !== oldCode) {
      continue
    }
    schedule.displayed = { ...schedule.displayed, detailCode: newCode, detailVersion }
  }
}

/** 同一条明细被并发写了两份时，按批次去重合并复用记录，次数取较大值。 */
function mergeSameArchive(mine: ChartRefreshArchive, other: ChartRefreshArchive): void {
  for (const event of other.reuseEvents) {
    const exists = mine.reuseEvents.some(
      (item) => item.batchId === event.batchId && item.chartNo === event.chartNo,
    )
    if (!exists) {
      mine.reuseEvents.push(event)
    }
  }
  mine.reuseCount = Math.max(mine.reuseCount, other.reuseCount)
  for (const chartNo of other.chartNos) {
    if (!mine.chartNos.includes(chartNo)) {
      mine.chartNos.push(chartNo)
    }
  }
  for (const config of other.chartConfigs) {
    replaceBy(mine.chartConfigs, (item) => chartNoOf(item) === chartNoOf(config), clone(config))
  }
  for (const snapshot of other.chartSnapshots) {
    replaceBy(mine.chartSnapshots, (item) => item.chartNo === snapshot.chartNo, clone(snapshot))
  }
  mine.updatedAt = other.updatedAt > mine.updatedAt ? other.updatedAt : mine.updatedAt
}

/** 同一坐标 + 窗口 + 版本只保留一份明细；重复的并入保留项并在复用记录里写明取舍。 */
function dedupeArchives(state: ChartRefreshState): boolean {
  const canonical = new Map<string, ChartRefreshArchive>()
  for (const archive of Object.values(state.archives)) {
    const key = detailKey(archive.coordinateKey, archive.window, archive.sourceVersion)
    const kept = canonical.get(key)
    if (!kept || archive.detailId < kept.detailId) {
      canonical.set(key, archive)
    }
  }
  let changed = false
  for (const archive of Object.values(state.archives)) {
    const kept = canonical.get(
      detailKey(archive.coordinateKey, archive.window, archive.sourceVersion),
    )
    if (!kept || kept.detailCode === archive.detailCode) {
      continue
    }
    mergeArchive(kept, archive)
    remapDisplayed(state, archive, kept)
    delete state.archives[archive.detailCode]
    state.detailSeq = Math.max(state.detailSeq, archive.detailId)
    changed = true
  }
  return changed
}

/** 把重复明细的成果并入保留的那份，复用记录里写明取舍。 */
function mergeArchive(kept: ChartRefreshArchive, duplicate: ChartRefreshArchive): void {
  for (const chartNo of duplicate.chartNos) {
    if (!kept.chartNos.includes(chartNo)) {
      kept.chartNos.push(chartNo)
    }
  }
  for (const config of duplicate.chartConfigs) {
    replaceBy(kept.chartConfigs, (item) => chartNoOf(item) === chartNoOf(config), clone(config))
  }
  for (const snapshot of duplicate.chartSnapshots) {
    replaceBy(kept.chartSnapshots, (item) => item.chartNo === snapshot.chartNo, {
      ...clone(snapshot),
      detailCode: kept.detailCode,
      detailVersion: kept.detailVersion,
    })
  }
  kept.reuseCount += duplicate.reuseCount
  kept.updatedAt = duplicate.updatedAt > kept.updatedAt ? duplicate.updatedAt : kept.updatedAt
  kept.reuseEvents.push({
    batchId: duplicate.reuseEvents[duplicate.reuseEvents.length - 1]?.batchId ?? '',
    chartNo: duplicate.chartNos[0] ?? '',
    at: duplicate.updatedAt,
    window: duplicate.window,
    mode: '并发合并',
    intervalSeconds: 0,
    scheduledVersion: duplicate.sourceVersion,
    chosenVersion: kept.sourceVersion,
    reused: true,
    reason: `并发批次产生了重复的 ${duplicate.detailCode}，已并入先落盘的 ${kept.detailCode}，仅保留一份明细`,
  })
}

function remapDisplayed(
  state: ChartRefreshState,
  duplicate: ChartRefreshArchive,
  kept: ChartRefreshArchive,
): void {
  for (const chartNo of duplicate.chartNos) {
    const schedule = state.charts[chartNo]
    if (!schedule?.displayed || schedule.displayed.detailCode !== duplicate.detailCode) {
      continue
    }
    schedule.displayed = {
      ...schedule.displayed,
      detailCode: kept.detailCode,
      detailVersion: kept.detailVersion,
    }
  }
}

/** 把新登记的图表、新出现的数据源纳入调度；不改动已展示快照。 */
function syncCharts(state: ChartRefreshState, now: number): boolean {
  let changed = false
  const meta = MODULE_BY_KEY.get(CHART_KEY)
  const intervalField = meta?.fields.find((field) => field.includes('刷新间隔')) ?? '刷新间隔秒'
  for (const row of chartRows()) {
    const no = chartNoOf(row)
    const source = sourceOf(row)
    if (!state.sourceVersions[source]) {
      state.sourceVersions[source] = 1
      changed = true
    }
    const version = state.sourceVersions[source]
    const current = state.charts[no]
    if (!current) {
      state.charts[no] = createSchedule(row, now, version)
      changed = true
      continue
    }
    const rowInterval = Number(text(row, intervalField))
    if (Number.isFinite(rowInterval) && Math.floor(rowInterval) !== current.intervalSeconds) {
      // 外部直接改配置时按「间隔变更」处理：只影响后续到期任务，已展示快照保持可用。
      scheduleIntervalChange(current, Math.floor(rowInterval), now)
      changed = true
    }    if (current.scheduledVersion === null) {
      current.scheduledVersion = version
      changed = true
    }
  }
  return changed
}

/** 间隔变更：已到期的任务继续执行一次；未到期的按新间隔重排，展示快照不动。 */
function scheduleIntervalChange(schedule: ChartScheduleState, seconds: number, now: number): void {
  const intervalSeconds = Math.min(
    MAX_INTERVAL_SECONDS,
    Math.max(MIN_INTERVAL_SECONDS, Math.floor(seconds)),
  )
  const wasDue = schedule.nextDueAt <= now
  schedule.intervalSeconds = intervalSeconds
  schedule.lastIntervalChangeAt = now
  if (!wasDue) {
    schedule.nextDueAt = now + intervalSeconds * 1000
  }
}

function detailKey(coordinateKey: string, window: string, sourceVersion: number): string {
  return `${coordinateKey}#${window}#v${sourceVersion}`
}

/** 复用索引：坐标 + 窗口 + 版本 -> 已完成的聚合，查找 O(1) 而不是逐条扫。 */
function buildReuseIndex(state: ChartRefreshState): Map<string, ChartRefreshArchive> {
  const index = new Map<string, ChartRefreshArchive>()
  for (const archive of Object.values(state.archives)) {
    index.set(detailKey(archive.coordinateKey, archive.window, archive.sourceVersion), archive)
  }
  return index
}

function replaceBy<T>(items: T[], match: (item: T) => boolean, next: T): void {
  const index = items.findIndex(match)
  if (index >= 0) {
    items[index] = next
  } else {
    items.push(next)
  }
}

function snapshotOf(
  row: EntryRow,
  archive: ChartRefreshArchive,
  refreshedAt: string,
  reused: boolean,
): ChartSnapshot {
  return {
    chartNo: chartNoOf(row),
    chartName: text(row, '图表名称'),
    chartType: text(row, '图表类型'),
    dataSource: sourceOf(row),
    xAxis: text(row, 'X轴字段'),
    yAxis: text(row, 'Y轴字段'),
    window: archive.window,
    sourceVersion: archive.sourceVersion,
    detailCode: archive.detailCode,
    detailVersion: archive.detailVersion,
    coordinateValues: archive.coordinateValues,
    resultValue: archive.resultValue,
    refreshedAt,
    reused,
  }
}

function nextVersion(state: ChartRefreshState, coordinateKey: string): string {
  const lineage = Object.values(state.archives).filter(
    (archive) => archive.coordinateKey === coordinateKey,
  ).length
  return `v${lineage + 1}`
}

function emptySummary(message: string, windowLabel: string): ChartRefreshSummary {
  return {
    ok: true,
    message,
    batchId: '',
    window: windowLabel,
    computed: 0,
    reused: 0,
    charts: [],
    details: [],
  }
}

/**
 * 处理所有到期图表。同一时刻到期的请求会合并成一批：
 * - 相同坐标 + 窗口 + 版本只计算一次聚合；
 * - 并发调用只让第一个批次落盘，其余直接返回「无到期任务」，不会产生第二份明细。
 */
export function runDueChartRefreshes(
  options: { now?: number; force?: boolean; mode?: string } = {},
): ChartRefreshSummary {
  const now = options.now ?? Date.now()
  const mode = options.mode ?? (options.force ? '强制刷新' : '到期刷新')
  const window = formatWindow(now)

  if (inFlight) {
    return {
      ok: false,
      message: '已有刷新批次在执行，本次请求复用同一份图表刷新结果字段明细',
      batchId: '',
      window,
      computed: 0,
      reused: 0,
      charts: [],
      details: [],
    }
  }

  inFlight = true
  try {
    const state = loadState(now)
    syncCharts(state, now)

    const due = chartRows().filter((row) => {
      const schedule = state.charts[chartNoOf(row)]
      return schedule && (options.force === true || schedule.nextDueAt <= now)
    })

    if (due.length === 0) {
      persist(state)
      const next = Object.values(state.charts)
        .map((schedule) => schedule.nextDueAt)
        .sort((left, right) => left - right)[0]
      return emptySummary(
        next ? `当前没有到期图表，最近一次到期在 ${formatClock(next)}` : '没有登记图表配置',
        window,
      )
    }

    const batchSeq = state.batchSeq + 1
    const batchId = `BATCH-${pad(batchSeq, 4)}`
    // 批次开始即固定时间窗口与数据源版本：同一批里不会混入旧坐标值或新版本。
    const versionSnapshot: Record<string, number> = { ...state.sourceVersions }
    const refreshedAt = isoAt(now)
    const touchedDetails = new Map<string, ChartRefreshSummary['details'][number]>()
    // 批量开始建立一次复用索引，之后每条到期请求都是 O(1) 命中，刷新耗时不再随图表数量线性放大。
    const reuseIndex = buildReuseIndex(state)
    const charts: string[] = []
    let computed = 0
    let reused = 0

    for (const row of due) {
      const no = chartNoOf(row)
      const schedule = state.charts[no]
      if (!schedule) {
        continue
      }
      const source = sourceOf(row)
      const sourceVersion = versionSnapshot[source] ?? 1
      const scheduledVersion = schedule.scheduledVersion
      const coordinateKey = coordinateKeyOf(row)
      const coordinate = coordinateOf(row)
      const key = detailKey(coordinateKey, window, sourceVersion)

      let archive = reuseIndex.get(key) ?? null
      let isReused = true
      let reason = '同坐标、同窗口、同版本，复用已完成的图表聚合'

      if (!archive) {
        state.detailSeq += 1
        const detailCode = `CRFD-${pad(state.detailSeq, 4)}`
        archive = {
          detailId: state.detailSeq,
          detailCode,
          detailVersion: nextVersion(state, coordinateKey),
          createdAt: refreshedAt,
          updatedAt: refreshedAt,
          window,
          source,
          coordinateKey,
          sourceVersion,
          coordinateValues: coordinate,
          resultValue: aggregate(source, coordinateKey, window, sourceVersion, text(row, 'Y轴字段')),
          reuseCount: 0,
          chartNos: [],
          chartConfigs: [],
          chartSnapshots: [],
          reuseEvents: [],
        }
        state.archives[archive.detailCode] = archive
        // 同批后续的同坐标请求直接命中，不再重复计算。
        reuseIndex.set(key, archive)
        isReused = false
        reason = '首个到期请求，执行一次聚合后共享给同组图表'
        computed += 1
      } else {
        reused += 1
        archive.reuseCount += 1
        archive.updatedAt = refreshedAt
      }

      if (scheduledVersion !== null && scheduledVersion !== sourceVersion) {
        // 冲突处理保留来源取舍：窗口内统一采用批次快照版本，旧版本坐标值不混入。
        reason = `版本冲突：调度时数据源 v${scheduledVersion}，执行时 v${sourceVersion}，本窗口采用 v${sourceVersion}；${reason}`
      }

      const snapshot = snapshotOf(row, archive, refreshedAt, isReused)
      if (!archive.chartNos.includes(no)) {
        archive.chartNos.push(no)
      }
      replaceBy(archive.chartConfigs, (item) => chartNoOf(item) === no, clone(row))
      replaceBy(archive.chartSnapshots, (item) => item.chartNo === no, snapshot)
      const event: ChartRefreshReuseEvent = {
        batchId,
        chartNo: no,
        at: refreshedAt,
        window,
        mode,
        intervalSeconds: schedule.intervalSeconds,
        scheduledVersion,
        chosenVersion: sourceVersion,
        reused: isReused,
        reason,
      }
      archive.reuseEvents.push(event)

      schedule.displayed = {
        detailId: archive.detailId,
        detailCode: archive.detailCode,
        detailVersion: archive.detailVersion,
        window: archive.window,
        sourceVersion: archive.sourceVersion,
        coordinateValues: archive.coordinateValues,
        resultValue: archive.resultValue,
        refreshedAt,
      }
      schedule.lastRefreshAt = now
      schedule.scheduledVersion = sourceVersion
      schedule.nextDueAt = now + schedule.intervalSeconds * 1000

      charts.push(no)
      const detail = touchedDetails.get(archive.detailCode) ?? {
        id: archive.detailId,
        code: archive.detailCode,
        detailVersion: archive.detailVersion,
        sourceVersion: archive.sourceVersion,
        reuseCount: archive.reuseCount,
        computed: false,
      }
      detail.reuseCount = archive.reuseCount
      detail.computed = detail.computed || !isReused
      touchedDetails.set(archive.detailCode, detail)
    }

    state.batchSeq = batchSeq
    state.lastWindow = window
    state.lastBatchId = batchId
    persist(state)

    return {
      ok: true,
      message: `批次 ${batchId} 处理 ${charts.length} 张图表，计算 ${computed} 次，复用 ${reused} 次（窗口 ${window}）`,
      batchId,
      window,
      computed,
      reused,
      charts,
      details: [...touchedDetails.values()],
    }
  } finally {
    inFlight = false
  }
}

/** 修改某张图表的刷新间隔：只影响它后续的到期任务，其他坐标的展示快照不受影响。 */
export function setChartInterval(
  chartNo: string,
  seconds: number,
  now: number = Date.now(),
): ActionResult {
  const value = Number(seconds)
  if (!Number.isFinite(value) || Math.floor(value) < MIN_INTERVAL_SECONDS) {
    return { ok: false, message: `刷新间隔至少 ${MIN_INTERVAL_SECONDS} 秒` }
  }
  const rows = chartRows()
  const index = rows.findIndex((row) => chartNoOf(row) === chartNo)
  if (index < 0) {
    return { ok: false, message: `没有找到图表 ${chartNo}` }
  }
  const intervalSeconds = Math.min(MAX_INTERVAL_SECONDS, Math.floor(value))
  const updated: EntryRow = { ...rows[index], 刷新间隔秒: String(intervalSeconds) }
  const next = [...rows]
  next[index] = updated
  saveRows(CHART_KEY, next)

  const state = loadState(now)
  // syncCharts 会按配置里的新间隔重排：未到期的按新间隔、已到期的照常执行一次。
  syncCharts(state, now)
  const schedule = state.charts[chartNo]
  if (schedule && schedule.intervalSeconds !== intervalSeconds) {
    scheduleIntervalChange(schedule, intervalSeconds, now)
  }
  persist(state)

  return {
    ok: true,
    message: `${chartNo} 刷新间隔已改为 ${intervalSeconds} 秒，只影响后续到期任务；已展示快照保持可用`,
  }
}

/** 数据源版本递增，用于核对窗口内新旧版本隔离。 */
export function bumpDataSourceVersion(source: string, now: number = Date.now()): ActionResult {
  const state = loadState(now)
  syncCharts(state, now)
  if (!state.sourceVersions[source]) {
    return { ok: false, message: `没有登记数据来源 ${source}` }
  }
  state.sourceVersions[source] += 1
  persist(state)
  return {
    ok: true,
    message: `${source} 数据源版本已升到 v${state.sourceVersions[source]}，下一次刷新才采用新版本`,
  }
}

/** 图表配置变更后同步归档里的配置快照，保持「配置随结果归档」。 */
export function syncChartConfig(row: EntryRow): void {
  const state = rereadChartRefreshState<ChartRefreshState>()
  if (!state || state.stateVersion !== STATE_VERSION) {
    return
  }
  const no = chartNoOf(row)
  for (const archive of Object.values(state.archives)) {
    if (!archive.chartNos.includes(no)) {
      continue
    }
    replaceBy(archive.chartConfigs, (item) => chartNoOf(item) === no, clone(row))
    const snapshot = archive.chartSnapshots.find((item) => item.chartNo === no)
    if (snapshot) {
      snapshot.chartName = text(row, '图表名称')
      snapshot.chartType = text(row, '图表类型')
      snapshot.dataSource = sourceOf(row)
      snapshot.xAxis = text(row, 'X轴字段')
      snapshot.yAxis = text(row, 'Y轴字段')
    }
  }
  // 仍走唯一落盘口，避免和并发刷新互相覆盖。
  persist(state)
}

export function chartRefreshOverview(now: number = Date.now()): ChartRefreshOverview {
  const state = loadState(now)
  syncCharts(state, now)
  persist(state)

  const sourceVersions: ChartSourceVersionView[] = Object.keys(state.sourceVersions)
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
    .map((source) => ({ source, version: state.sourceVersions[source] }))

  const schedules: ChartScheduleView[] = chartRows()
    .map((row): ChartScheduleView | null => {
      const no = chartNoOf(row)
      const schedule = state.charts[no]
      if (!schedule) {
        return null
      }
      return {
        id: Number(row.id),
        chartNo: no,
        chartName: text(row, '图表名称'),
        dataSource: sourceOf(row),
        xAxis: text(row, 'X轴字段'),
        yAxis: text(row, 'Y轴字段'),
        intervalSeconds: schedule.intervalSeconds,
        nextDueAt: schedule.nextDueAt,
        nextDueLabel: formatClock(schedule.nextDueAt),
        due: schedule.nextDueAt <= now,
        displayed: schedule.displayed,
      }
    })
    .filter((item): item is ChartScheduleView => item !== null)

  const archives = Object.values(state.archives)
  return {
    sourceVersions,
    schedules,
    detailTotal: archives.length,
    archivedTotal: archives.reduce((sum, item) => sum + item.chartSnapshots.length, 0),
    lastWindow: state.lastWindow,
  }
}

/** 明细行：列表、检索、导出都读这一份投影，保证三者对得上。 */
export function chartRefreshRows(): EntryRow[] {
  // 列表每次都读最新落盘的一份：导出、筛选和列表看到的是同一份明细。
  const state = rereadChartRefreshState<ChartRefreshState>()
  if (!state || state.stateVersion !== STATE_VERSION) {
    return []
  }
  return Object.values(state.archives)
    .sort((left, right) => left.detailId - right.detailId)
    .map((archive) => ({
      id: archive.detailId,
      status: '已归档',
      pending: false,
      abnormal: false,
      明细编号: archive.detailCode,
      图表编号: archive.chartNos.join(','),
      数据来源: archive.source,
      坐标值: archive.coordinateValues,
      时间窗口: archive.window,
      数据源版本: `v${archive.sourceVersion}`,
      明细版本: archive.detailVersion,
      复用次数: archive.reuseCount,
      结果值: archive.resultValue,
      刷新时刻: archive.updatedAt,
    }))
}

export function chartRefreshDetail(code: string): ChartRefreshDetailView | null {
  const state = rereadChartRefreshState<ChartRefreshState>()
  const row = chartRefreshRows().find((item) => String(item.明细编号) === code)
  if (!row) {
    return null
  }
  const archive = state?.archives[code]
  return { row, archive: archive ? clone(archive) : null }
}

export function resetChartRefresh(): ChartRefreshOverview {
  clearChartRefreshState()
  return chartRefreshOverview()
}
