import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'data-explore-studio:entries'
// 图表刷新状态单独存一份：图表刷新结果字段明细随文件保存，版本与窗口都跟着走。
const CHART_REFRESH_KEY = 'data-explore-studio:chart-refresh'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null
let chartCache: unknown = null
let chartLoaded = false

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 读取图表刷新状态；没有落盘时返回 null，由调用方给出初始状态。 */
export function readChartRefreshState<T>(): T | null {
  if (chartLoaded) {
    return (chartCache as T | null) ?? null
  }
  return rereadChartRefreshState<T>()
}

/** 强制从存储重读一次图表刷新状态，用于跨标签页的并发核对。 */
export function rereadChartRefreshState<T>(): T | null {
  chartLoaded = true
  chartCache = null
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(CHART_REFRESH_KEY)
  if (!raw) {
    return null
  }
  try {
    chartCache = JSON.parse(raw)
  } catch {
    window.localStorage.removeItem(CHART_REFRESH_KEY)
    chartCache = null
  }
  return (chartCache as T | null) ?? null
}

/** 唯一落盘口：图表刷新结果字段明细的版本随文件一起写入。 */
export function saveChartRefreshState<T>(state: T): void {
  chartLoaded = true
  chartCache = clone(state)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(CHART_REFRESH_KEY, JSON.stringify(state))
  }
}

export function clearChartRefreshState(): void {
  chartLoaded = true
  chartCache = null
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(CHART_REFRESH_KEY)
  }
}

export function chartRefreshStorageKey(): string {
  return CHART_REFRESH_KEY
}
