<template>
  <section class="page" data-module="chart">
    <header class="page-head">
      <div>
        <h2>可视化图表管理</h2>
        <p class="page-desc">维护可视化图表配置的输入、执行约束与结果记录，为图表展示提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记图表配置</button>
        <button class="btn" type="button" @click="exportRows">导出可视化图表清单</button>
        <RouterLink class="btn" to="/chart-refresh">查看刷新明细</RouterLink>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section class="panel" data-panel="chart-refresh">
      <header class="panel-head">
        <div>
          <h3>图表刷新调度</h3>
          <p class="panel-desc">
            同一坐标（数据来源 + X 轴 + Y 轴）与同一时间窗口只计算一次，其余到期图表复用同一份图表刷新结果字段明细。
          </p>
        </div>
        <div class="page-actions">
          <button class="btn primary" type="button" @click="refreshDue">处理到期刷新</button>
          <button class="btn" type="button" @click="refreshAll">强制刷新全部</button>
        </div>
      </header>

      <p v-if="refreshMessage" class="refresh-message" data-role="refresh-message">{{ refreshMessage }}</p>

      <div class="source-bar">
        <span class="source-label">数据源版本：</span>
        <span v-for="item in sourceVersions" :key="item.source" class="source-chip">
          {{ item.source }} <strong>v{{ item.version }}</strong>
          <button class="link" type="button" @click="bumpVersion(item.source)">升版本</button>
        </span>
        <span v-if="!sourceVersions.length" class="empty-inline">暂无数据源</span>
      </div>

      <table class="data-table">
        <thead>
          <tr>
            <th>图表编号</th>
            <th>数据来源</th>
            <th>坐标（X / Y）</th>
            <th>刷新间隔</th>
            <th>下次到期</th>
            <th>已展示明细</th>
            <th>已展示快照</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in schedules" :key="item.chartNo">
            <td>{{ item.chartNo }}</td>
            <td>{{ item.dataSource }}</td>
            <td>{{ item.xAxis }} / {{ item.yAxis }}</td>
            <td class="interval-cell">
              <input v-model="intervalDraft[item.chartNo]" class="interval-input" type="number" min="5" />
              <button class="link" type="button" @click="applyInterval(item.chartNo)">应用</button>
            </td>
            <td>
              {{ item.nextDueLabel }}
              <span v-if="item.due" class="due-badge">已到期</span>
            </td>
            <td>
              <template v-if="item.displayed">
                <span class="detail-code">{{ item.displayed.detailCode }}</span>
                <span class="muted">（{{ item.displayed.detailVersion }} · v{{ item.displayed.sourceVersion }} · {{ item.displayed.window }}）</span>
              </template>
              <span v-else class="muted">尚未刷新</span>
            </td>
            <td>
              <template v-if="item.displayed">
                {{ item.displayed.coordinateValues }} → {{ item.displayed.resultValue }}
              </template>
              <span v-else class="muted">—</span>
            </td>
          </tr>
          <tr v-if="!schedules.length">
            <td colspan="7" class="empty-state">暂无图表配置</td>
          </tr>
        </tbody>
      </table>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无可视化图表数据，可先登记图表配置</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条可视化图表记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  bumpDataSourceVersion,
  chartRefreshOverview,
  runDueChartRefreshes,
  setChartInterval,
} from '@/api/chart-refresh'
import type { ChartRefreshOverview, ChartScheduleView, EntryRow } from '@/data/types'

const meta = moduleMeta('chart')
const columns = ["图表编号", "图表名称", "图表类型", "数据来源", "X轴字段", "Y轴字段", "配色方案", "刷新间隔秒"]
const actions = ["提交发布", "发布图表", "下线图表"]
const statuses = ["草稿", "待发布", "已发布", "已下线"]
const stats = [{"label": "图表配置总数", "value": 0}, {"label": "已发布图表", "value": 0}, {"label": "待发布图表", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const refreshMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const sourceVersions = ref<ChartRefreshOverview['sourceVersions']>([])
const schedules = ref<ChartScheduleView[]>([])
const intervalDraft = reactive<Record<string, string>>({})
let timer: number | null = null

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function syncRefreshPanel() {
  const overview = chartRefreshOverview()
  sourceVersions.value = overview.sourceVersions
  schedules.value = overview.schedules
  for (const item of overview.schedules) {
    intervalDraft[item.chartNo] = String(item.intervalSeconds)
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '图表配置登记入口尚未接入审批流'
}

function refreshDue() {
  const result = runDueChartRefreshes()
  refreshMessage.value = result.message
  syncRefreshPanel()
}

function refreshAll() {
  const result = runDueChartRefreshes({ force: true, mode: '强制刷新' })
  refreshMessage.value = result.message
  syncRefreshPanel()
}

function applyInterval(chartNo: string) {
  const raw = Number(intervalDraft[chartNo])
  const result = setChartInterval(chartNo, raw)
  refreshMessage.value = result.message
  if (!result.ok) {
    return
  }
  syncRefreshPanel()
  reload()
}

function bumpVersion(source: string) {
  const result = bumpDataSourceVersion(source)
  refreshMessage.value = result.message
  syncRefreshPanel()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  syncRefreshPanel()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '可视化图表列表读取失败'
  }
}

onMounted(() => {
  reload()
  syncRefreshPanel()
  // 到期任务按秒推进：同一分钟到期的请求会合并成一批，不会重复生成结果。
  timer = window.setInterval(() => {
    const result = runDueChartRefreshes()
    if (result.charts.length > 0) {
      refreshMessage.value = result.message
    }
    syncRefreshPanel()
  }, 5_000)
})

onUnmounted(() => {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
})
</script>
