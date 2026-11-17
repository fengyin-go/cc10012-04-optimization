<template>
  <section class="page" data-module="chart-refresh">
    <header class="page-head">
      <div>
        <h2>图表刷新结果字段明细</h2>
        <p class="page-desc">
          按坐标维度复用的图表聚合结果：明细标明时间窗口、坐标值与数据源版本，图表配置与图表快照随结果归档。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="refreshDue">处理到期刷新</button>
        <button class="btn" type="button" @click="exportRows">导出字段明细</button>
        <RouterLink class="btn" to="/chart">返回图表配置</RouterLink>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in cards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="message" class="refresh-message" data-role="refresh-message">{{ message }}</p>

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
          <th v-for="field in fields" :key="field">{{ field }}</th>
          <th>定位</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          :class="{ 'row-selected': selectedCode === String(row.明细编号) }"
          :data-detail-code="String(row.明细编号)"
        >
          <td v-for="field in fields" :key="field">{{ row[field] ?? '—' }}</td>
          <td>
            <button class="link" type="button" @click="select(String(row.明细编号))">查看归档</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="fields.length + 1" class="empty-state">
            暂无图表刷新结果字段明细，可先到可视化图表页处理到期刷新
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条明细（检索条件：{{ filterSummary }}）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section v-if="detail" class="panel" data-panel="chart-refresh-detail">
      <header class="panel-head">
        <div>
          <h3>{{ detail.row.明细编号 }} · {{ detail.row.明细版本 }}</h3>
          <p class="panel-desc">
            时间窗口 {{ detail.row.时间窗口 }}，数据源版本 {{ detail.row.数据源版本 }}，坐标值 {{ detail.row.坐标值 }}。
          </p>
        </div>
      </header>

      <div class="detail-grid">
        <div><span class="muted">结果值</span><strong>{{ detail.row.结果值 }}</strong></div>
        <div><span class="muted">复用次数</span><strong>{{ detail.row.复用次数 }}</strong></div>
        <div><span class="muted">关联图表</span><strong>{{ detail.row.图表编号 }}</strong></div>
        <div><span class="muted">刷新时刻</span><strong>{{ detail.row.刷新时刻 }}</strong></div>
      </div>

      <h4>图表快照（随结果归档）</h4>
      <table v-if="detail.archive" class="data-table">
        <thead>
          <tr>
            <th>图表编号</th>
            <th>图表名称</th>
            <th>图表类型</th>
            <th>时间窗口</th>
            <th>数据源版本</th>
            <th>明细版本</th>
            <th>结果值</th>
            <th>来源</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in detail.archive.chartSnapshots" :key="item.chartNo">
            <td>{{ item.chartNo }}</td>
            <td>{{ item.chartName }}</td>
            <td>{{ item.chartType }}</td>
            <td>{{ item.window }}</td>
            <td>v{{ item.sourceVersion }}</td>
            <td>{{ item.detailVersion }}</td>
            <td>{{ item.resultValue }}</td>
            <td>{{ item.reused ? '复用聚合' : '直接计算' }}</td>
          </tr>
        </tbody>
      </table>

      <h4>复用与版本取舍记录</h4>
      <ul v-if="detail.archive" class="event-list">
        <li v-for="(event, index) in detail.archive.reuseEvents" :key="`${event.batchId}-${index}`">
          <span class="muted">{{ event.at }}</span>
          · {{ event.chartNo }} · {{ event.mode }} · 间隔 {{ event.intervalSeconds }} 秒 ·
          {{ event.reused ? '复用' : '计算' }} · 采用 v{{ event.chosenVersion }} — {{ event.reason }}
        </li>
        <li v-if="!detail.archive.reuseEvents.length" class="muted">暂无记录</li>
      </ul>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  CHART_REFRESH_FILTER_FIELDS,
  CHART_REFRESH_FIELDS,
  CHART_REFRESH_NAME,
  chartRefreshDetail,
  chartRefreshOverview,
  runDueChartRefreshes,
} from '@/api/chart-refresh'
import {
  CHART_REFRESH_MODULE,
  downloadEntries,
  listEntries,
} from '@/api/local-service'
import type { ChartRefreshDetailView, EntryRow } from '@/data/types'

const fields = CHART_REFRESH_FIELDS
const filterFields = CHART_REFRESH_FILTER_FIELDS
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const message = ref('')
const filters = ref<Record<string, string>>({})
const selectedCode = ref('')
const detail = ref<ChartRefreshDetailView | null>(null)
const summary = ref({ detailTotal: 0, archivedTotal: 0, lastWindow: '', sources: 0 })

const cards = computed(() => [
  { label: `${CHART_REFRESH_NAME}条数`, value: summary.value.detailTotal },
  { label: '归档图表快照', value: summary.value.archivedTotal },
  { label: '数据源数', value: summary.value.sources },
  { label: '最近窗口', value: summary.value.lastWindow || '—' },
])

const filterSummary = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  return pairs.length ? pairs.map(([field, value]) => `${field}=${value}`).join('，') : '无'
})

function syncSummary() {
  const overview = chartRefreshOverview()
  summary.value = {
    detailTotal: overview.detailTotal,
    archivedTotal: overview.archivedTotal,
    lastWindow: overview.lastWindow,
    sources: overview.sourceVersions.length,
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(CHART_REFRESH_MODULE, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (selectedCode.value && !rows.value.some((row) => String(row.明细编号) === selectedCode.value)) {
      detail.value = null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '图表刷新结果字段明细读取失败'
  }
  syncSummary()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function select(code: string) {
  selectedCode.value = code
  detail.value = chartRefreshDetail(code)
}

function refreshDue() {
  const result = runDueChartRefreshes()
  message.value = result.message
  reload()
  if (selectedCode.value) {
    detail.value = chartRefreshDetail(selectedCode.value)
  }
}

function exportRows() {
  downloadEntries(CHART_REFRESH_MODULE)
}

onMounted(reload)
</script>
