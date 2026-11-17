/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 图表刷新明细相关的持久化结构；写入口统一在 api/chart-refresh.ts。 */

export type ChartDisplaySnapshot = {
  detailId: number
  detailCode: string
  detailVersion: string
  window: string
  sourceVersion: number
  coordinateValues: string
  resultValue: string
  refreshedAt: string
}

export type ChartScheduleState = {
  intervalSeconds: number
  nextDueAt: number
  lastRefreshAt: number | null
  displayed: ChartDisplaySnapshot | null
  /** 调度时看到的数据源版本，用于到期执行时记录来源取舍。 */
  scheduledVersion: number | null
  /** 最近一次刷新间隔变更时刻；只在后续到期任务上生效。 */
  lastIntervalChangeAt: number | null
}

export type ChartRefreshReuseEvent = {
  batchId: string
  chartNo: string
  at: string
  window: string
  mode: string
  intervalSeconds: number
  scheduledVersion: number | null
  chosenVersion: number
  reused: boolean
  reason: string
}

export type ChartSnapshot = {
  chartNo: string
  chartName: string
  chartType: string
  dataSource: string
  xAxis: string
  yAxis: string
  window: string
  sourceVersion: number
  detailCode: string
  detailVersion: string
  coordinateValues: string
  resultValue: string
  refreshedAt: string
  /** 这次展示是直接计算还是复用同坐标同窗口的聚合。 */
  reused: boolean
}

export type ChartRefreshArchive = {
  detailId: number
  detailCode: string
  detailVersion: string
  createdAt: string
  updatedAt: string
  window: string
  source: string
  coordinateKey: string
  sourceVersion: number
  coordinateValues: string
  resultValue: string
  /** 该明细被其他图表复用（或再次命中）的次数。 */
  reuseCount: number
  /** 共享同一明细的图表编号。 */
  chartNos: string[]
  chartConfigs: EntryRow[]
  chartSnapshots: ChartSnapshot[]
  reuseEvents: ChartRefreshReuseEvent[]
}

export type ChartRefreshState = {
  stateVersion: number
  sourceVersions: Record<string, number>
  charts: Record<string, ChartScheduleState>
  archives: Record<string, ChartRefreshArchive>
  detailSeq: number
  batchSeq: number
  lastWindow: string
  lastBatchId: string
}

export type ChartRefreshSummary = {
  ok: boolean
  message: string
  batchId: string
  window: string
  /** 实际只计算一次的分组数。 */
  computed: number
  /** 复用已完成聚合的图表次数。 */
  reused: number
  charts: string[]
  details: {
    id: number
    code: string
    detailVersion: string
    sourceVersion: number
    reuseCount: number
    computed: boolean
  }[]
}

export type ChartSourceVersionView = {
  source: string
  version: number
}

export type ChartScheduleView = {
  id: number
  chartNo: string
  chartName: string
  dataSource: string
  xAxis: string
  yAxis: string
  intervalSeconds: number
  nextDueAt: number
  nextDueLabel: string
  due: boolean
  displayed: ChartDisplaySnapshot | null
}

export type ChartRefreshOverview = {
  sourceVersions: ChartSourceVersionView[]
  schedules: ChartScheduleView[]
  detailTotal: number
  archivedTotal: number
  lastWindow: string
}

export type ChartRefreshDetailView = {
  row: EntryRow
  archive: ChartRefreshArchive | null
}
