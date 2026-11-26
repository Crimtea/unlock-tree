import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent,
  DragEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { createDemoTasks } from './demoData'
import { parseTaskFile, stringifyExportFile } from './taskData'
import {
  GAP_X,
  GAP_Y,
  NODE_H,
  NODE_W,
  PAD,
  completedIdSet,
  describeRequirement,
  formatLayout,
  getEdges,
  getLayers,
  getLayout,
  getPatterns,
  isRequirementMet,
  moveToPosition,
  moveToSlot,
  nextSlotInLayer,
  pruneRequirement,
  revalidateTasks,
  swapSlots,
  wouldCreateCycle,
} from './taskEngine'
import type { Requirement, Task } from './types'
import './App.css'

const STORAGE_KEY = 'unlock-tree:tasks'
const NAME_STORAGE_KEY = 'unlock-tree:name'
const DEMO_TREE_NAME = '示例数据'
const MIN_ZOOM = 0.05
const MAX_ZOOM = 2
const ZOOM_STEP = 0.1
/** 画布四周的可平移留白，使空白处也能拖拽移动视图 */
const CANVAS_MARGIN = 800

function loadTreeName(): string {
  try {
    // 从未保存过名称时才使用示例名；用户主动清空名称后保持为空
    return window.localStorage.getItem(NAME_STORAGE_KEY) ?? DEMO_TREE_NAME
  } catch {
    return DEMO_TREE_NAME
  }
}

function formatDateStamp(): string {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
}

/** 文件名中不允许的字符替换为短横线，避免导出失败 */
function safeFileNamePart(name: string): string {
  return name
    .trim()
    .slice(0, 60)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
}

const RULES = [
  { name: '一解锁一', desc: '完成 A → 解锁 B' },
  { name: '一解锁多', desc: '完成 A → 解锁 B、C、D' },
  { name: '多解锁一', desc: '完成 A 且 B → 解锁 C' },
  { name: '可选任务', desc: '完成 A 或 B → 解锁 C' },
  { name: '必须 + 可选', desc: '（A 或 B）且 C → 解锁 D' },
]

function loadTasks(): Task[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (
        Array.isArray(parsed) &&
        parsed.every(
          (item) =>
            item &&
            typeof item === 'object' &&
            typeof item.id === 'string' &&
            Array.isArray(item.requirement) &&
            typeof item.completed === 'boolean',
        )
      ) {
        const loaded = parsed as Task[]
        if (loaded.every((task) => typeof task.slot === 'number')) return loaded
        // 旧缓存没有槽位：按当前层级顺序补齐
        const slots = new Map<string, number>()
        for (const layer of getLayers(loaded)) {
          layer.forEach((task, index) => slots.set(task.id, index))
        }
        return loaded.map((task) => ({ ...task, slot: slots.get(task.id) ?? 0 }))
      }
    }
  } catch {
    // 本地缓存损坏时使用示例数据
  }
  return createDemoTasks()
}

interface RequirementEditorProps {
  task: Task
  tasks: Task[]
  onSave: (requirement: Requirement) => void
}

function RequirementEditor({ task, tasks, onSave }: RequirementEditorProps) {
  const [draft, setDraft] = useState<Requirement>(() =>
    task.requirement.map((group) => [...group]),
  )

  const titleOf = (id: string) =>
    tasks.find((item) => item.id === id)?.title ?? id

  const canAdd = (index: number, candidateId: string) => {
    const next = draft.map((group, i) =>
      i === index ? [...group, candidateId] : [...group],
    )
    return !wouldCreateCycle(tasks, task.id, next)
  }

  const changed =
    JSON.stringify(pruneRequirement(draft)) !==
    JSON.stringify(pruneRequirement(task.requirement))

  return (
    <div className="requirement-editor">
      <div className="editor-hint">
        每个条件组内的任务任选其一完成即可；多个条件组必须全部满足。
      </div>

      <div className="group-list">
        {draft.map((group, index) => (
          <div className="condition-group" key={`group-${index}`}>
            <div className="group-head">
              <span className="group-index">条件组 {index + 1}</span>
              <span className={`logic-tag ${draft.length > 1 ? 'and' : ''}`}>
                {draft.length > 1
                  ? '且 · 必须满足'
                  : group.length > 1
                    ? '或 · 任选其一'
                    : '必须满足'}
              </span>
              <button
                type="button"
                className="icon-btn"
                title="删除该条件组"
                onClick={() =>
                  setDraft((prev) => prev.filter((_, i) => i !== index))
                }
              >
                ×
              </button>
            </div>

            <div className="chip-row">
              {group.length === 0 && (
                <span className="group-empty">空条件组（保存时会被忽略）</span>
              )}
              {group.map((id) => (
                <span className="task-chip" key={id}>
                  {titleOf(id)}
                  <button
                    type="button"
                    title={`移除 ${titleOf(id)}`}
                    onClick={() =>
                      setDraft((prev) =>
                        prev.map((g, i) =>
                          i === index ? g.filter((item) => item !== id) : g,
                        ),
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>

            <select
              className="add-select"
              value=""
              onChange={(event) => {
                const id = event.target.value
                if (!id) return
                setDraft((prev) =>
                  prev.map((g, i) =>
                    i === index && !g.includes(id) ? [...g, id] : g,
                  ),
                )
              }}
            >
              <option value="">+ 添加前置任务</option>
              {tasks
                .filter((item) => item.id !== task.id && !group.includes(item.id))
                .map((item) => {
                  const allowed = canAdd(index, item.id)
                  return (
                    <option key={item.id} value={item.id} disabled={!allowed}>
                      {item.title}
                      {allowed ? '' : '（会形成循环依赖）'}
                    </option>
                  )
                })}
            </select>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="add-group-btn"
        onClick={() => setDraft((prev) => [...prev, []])}
      >
        + 添加条件组（与其他组为「且」）
      </button>

      <div className="condition-preview">
        <span>当前条件</span>
        <p>{describeRequirement(pruneRequirement(draft), titleOf)}</p>
      </div>

      <div className="editor-actions">
        <button
          type="button"
          className="save-btn"
          onClick={() => onSave(draft)}
          disabled={!changed}
        >
          保存前置条件
        </button>
        <button
          type="button"
          className="clear-cond-btn"
          onClick={() => setDraft([])}
        >
          设为起始任务
        </button>
      </div>
    </div>
  )
}

function RequirementPreview({
  task,
  tasks,
}: {
  task: Task
  tasks: Task[]
}) {
  const titleOf = (id: string) =>
    tasks.find((item) => item.id === id)?.title ?? id

  return (
    <div className="requirement-readonly">
      {task.requirement.length === 0 ? (
        <p className="detail-text">起始任务，无前置条件。</p>
      ) : (
        <>
          {task.requirement.map((group, index) => (
            <div className="readonly-group" key={`readonly-${index}`}>
              <span className="readonly-index">条件组 {index + 1}</span>
              <p className="detail-text">
                {group.length === 1
                  ? titleOf(group[0])
                  : group.map(titleOf).join(' 或 ')}
              </p>
            </div>
          ))}
          <div className="condition-preview readonly-summary">
            <span>解锁条件</span>
            <p>{describeRequirement(task.requirement, titleOf)}</p>
          </div>
        </>
      )}
    </div>
  )
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>(loadTasks)
  const [treeName, setTreeName] = useState(loadTreeName)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{
    x: number
    y: number
    kind: 'swap' | 'move' | 'position'
  } | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [isPanning, setIsPanning] = useState(false)
  const [toast, setToast] = useState<{
    text: string
    kind: 'ok' | 'warn'
  } | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const canvasScrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(zoom)
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null)
  const panRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    scrollLeft: number
    scrollTop: number
    moved: boolean
  } | null>(null)
  const suppressBlankClickRef = useRef(false)
  const layoutOriginRef = useRef<{ minColumn: number; minSlot: number } | null>(
    null,
  )

  function changeZoom(delta: number) {
    setZoom((prev) =>
      Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((prev + delta) * 10) / 10)),
    )
  }

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    // 初始把视图定位到留白与内容的交界处，四周都留出可平移空间
    const container = canvasScrollRef.current
    if (!container) return
    container.scrollLeft = CANVAS_MARGIN
    container.scrollTop = CANVAS_MARGIN
  }, [])

  useEffect(() => {
    const container = canvasScrollRef.current
    if (!container) return

    function handleWheel(event: WheelEvent) {
      if (event.deltaY === 0) return
      // 滚轮绑定到树图缩放，避免缩放时预览区域自身继续滚动
      event.preventDefault()
      const oldZoom = zoomRef.current
      const direction = event.deltaY > 0 ? -1 : 1
      const nextZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, Math.round((oldZoom + direction * ZOOM_STEP) * 10) / 10),
      )
      if (nextZoom === oldZoom) return

      // 以光标下的树图位置为锚点：用画布自身坐标，兼容四周留白
      const scroll = container!
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const ratio = nextZoom / oldZoom
      pendingScrollRef.current = {
        left: scroll.scrollLeft + (event.clientX - rect.left) * (ratio - 1),
        top: scroll.scrollTop + (event.clientY - rect.top) * (ratio - 1),
      }
      setZoom(nextZoom)
    }

    // React 的 onWheel 是被动监听，无法 preventDefault，需原生非被动监听
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [])

  useLayoutEffect(() => {
    const scroll = pendingScrollRef.current
    const container = canvasScrollRef.current
    if (!scroll || !container) return
    pendingScrollRef.current = null
    container.scrollLeft = scroll.left
    container.scrollTop = scroll.top
  }, [zoom])

  function handleCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    suppressBlankClickRef.current = false
    const target = event.target as HTMLElement
    // 节点保留点击与拖拽排序，按钮等控件也不参与平移
    if (target.closest('.task-node, button, input, select, textarea')) return

    const container = event.currentTarget
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      moved: false,
    }
    container.setPointerCapture(event.pointerId)
  }

  function handleCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    const dx = event.clientX - pan.startX
    const dy = event.clientY - pan.startY
    if (!pan.moved && Math.hypot(dx, dy) < 4) return
    if (!pan.moved) {
      pan.moved = true
      setIsPanning(true)
    }
    const container = event.currentTarget
    container.scrollLeft = pan.scrollLeft - dx
    container.scrollTop = pan.scrollTop - dy
  }

  function handleCanvasPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // 平移结束时浏览器仍可能派发 click，不应因此关闭任务详情
    suppressBlankClickRef.current = pan.moved
    panRef.current = null
    setIsPanning(false)
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
    } catch {
      // 存储不可用时忽略
    }
  }, [tasks])

  useEffect(() => {
    try {
      window.localStorage.setItem(NAME_STORAGE_KEY, treeName)
    } catch {
      // 存储不可用时忽略
    }
  }, [treeName])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const byId = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  )
  const done = useMemo(() => completedIdSet(tasks), [tasks])
  const layout = useMemo(() => getLayout(tasks), [tasks])
  const edges = useMemo(() => getEdges(tasks), [tasks])
  const patterns = useMemo(() => getPatterns(tasks), [tasks])

  useLayoutEffect(() => {
    const previous = layoutOriginRef.current
    layoutOriginRef.current = {
      minColumn: layout.minColumn,
      minSlot: layout.minSlot,
    }
    if (!previous) return
    const dColumn = layout.minColumn - previous.minColumn
    const dSlot = layout.minSlot - previous.minSlot
    if (!dColumn && !dSlot) return
    const container = canvasScrollRef.current
    if (!container) return
    // 原点变化会整体平移其他节点，补偿滚动让视觉位置保持不变
    container.scrollLeft -= dColumn * (NODE_W + GAP_X) * zoom
    container.scrollTop -= dSlot * (NODE_H + GAP_Y) * zoom
  }, [layout.minColumn, layout.minSlot, zoom])

  function fitZoom() {
    const container = canvasScrollRef.current
    if (!container) return

    // 空树时复位到默认缩放与左上角起点
    if (tasks.length === 0) {
      const origin = { left: CANVAS_MARGIN, top: CANVAS_MARGIN }
      if (zoom === 1) {
        container.scrollLeft = origin.left
        container.scrollTop = origin.top
      } else {
        pendingScrollRef.current = origin
        setZoom(1)
      }
      return
    }

    // 以实际节点范围计算，避免空槽或负坐标让整树被无谓缩小
    const points = [...layout.positions.values()]
    if (points.length === 0) return
    const minX = Math.min(...points.map((point) => point.x))
    const minY = Math.min(...points.map((point) => point.y))
    const maxX = Math.max(...points.map((point) => point.x + NODE_W))
    const maxY = Math.max(...points.map((point) => point.y + NODE_H))
    const contentWidth = maxX - minX
    const contentHeight = maxY - minY

    // 向下取整，避免四舍五入放大后反而超出可视区域
    const fitted = Math.min(
      Math.max(64, container.clientWidth - 32) / contentWidth,
      Math.max(64, container.clientHeight - 32) / contentHeight,
      MAX_ZOOM,
    )
    // 以 5% 为步进向下取整，低缩放下也能尽量贴近可视区域
    const nextZoom = Math.max(MIN_ZOOM, Math.floor(fitted * 20) / 20)

    // CSS zoom 会同时缩放画布自身的 left/top 偏移，留白也需乘以缩放比例
    const origin = CANVAS_MARGIN * nextZoom
    const scroll = {
      left:
        origin +
        minX * nextZoom +
        (contentWidth * nextZoom - container.clientWidth) / 2,
      top:
        origin +
        minY * nextZoom +
        (contentHeight * nextZoom - container.clientHeight) / 2,
    }
    if (nextZoom === zoom) {
      container.scrollLeft = scroll.left
      container.scrollTop = scroll.top
    } else {
      pendingScrollRef.current = scroll
      setZoom(nextZoom)
    }
  }

  const selected = selectedId ? (byId.get(selectedId) ?? null) : null
  const selectedLayerIds = useMemo(
    () =>
      selectedId
        ? (getLayers(tasks)
            .find((layer) => layer.some((task) => task.id === selectedId))
            ?.map((task) => task.id) ?? [])
        : [],
    [tasks, selectedId],
  )
  const selectedSlot = selected?.slot ?? -1
  const doneCount = done.size
  const readyCount = tasks.filter(
    (task) => !task.completed && isRequirementMet(task.requirement, done),
  ).length
  const lockedCount = tasks.length - doneCount - readyCount
  // 拖拽时画布可超出当前布局，落点提示框不会被原有边界裁掉
  const canvasWidth = Math.max(
    layout.width,
    dropHint ? dropHint.x + NODE_W + PAD : 0,
  )
  const canvasHeight = Math.max(
    layout.height,
    dropHint ? dropHint.y + NODE_H + PAD : 0,
  )

  const titleOf = (id: string) => byId.get(id)?.title ?? id
  const notify = (text: string, kind: 'ok' | 'warn' = 'ok') =>
    setToast({ text, kind })

  function toggleTask(id: string) {
    const task = byId.get(id)
    if (!task) return

    if (!task.completed && !isRequirementMet(task.requirement, done)) {
      notify('前置条件尚未满足，无法完成该任务', 'warn')
      return
    }

    const draft = tasks.map((item) =>
      item.id === id ? { ...item, completed: !item.completed } : item,
    )
    const result = revalidateTasks(draft)
    setTasks(result.tasks)

    if (result.revoked.length > 0) {
      notify(
        `已连带更新：${result.revoked.length} 个后置任务因条件缺失改为未完成`,
        'warn',
      )
    } else {
      notify(task.completed ? '已取消完成' : '任务已完成', 'ok')
    }
  }

  function updateRequirement(id: string, requirement: Requirement) {
    const next = pruneRequirement(requirement)
    if (wouldCreateCycle(tasks, id, next)) {
      notify('该条件会形成循环依赖，已阻止保存', 'warn')
      return
    }

    const draft = tasks.map((item) =>
      item.id === id ? { ...item, requirement: next } : item,
    )
    const result = revalidateTasks(draft)
    setTasks(result.tasks)

    if (result.revoked.length > 0) {
      notify(
        `前置条件已保存，${result.revoked.length} 个已完成任务因不再满足条件被重置`,
        'warn',
      )
    } else {
      notify('前置条件已保存', 'ok')
    }
  }

  function addTask() {
    const id = `task-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`
    const newTask: Task = {
      id,
      title: `新任务 ${tasks.length + 1}`,
      note: '',
      requirement: selectedId ? [[selectedId]] : [],
      completed: false,
      slot: 0,
    }
    const draft = [...tasks, newTask]
    const newLayer =
      getLayers(draft).find((layer) => layer.some((task) => task.id === id)) ?? []
    const slot = nextSlotInLayer(
      draft,
      newLayer.map((task) => task.id),
    )
    setTasks(
      draft.map((task) => (task.id === id ? { ...task, slot } : task)),
    )
    setSelectedId(id)
    notify(
      selectedId
        ? '已新增任务，并默认把当前任务设为它的前置条件'
        : '已新增起始任务',
      'ok',
    )
  }

  function deleteTask(id: string) {
    const title = byId.get(id)?.title ?? '该任务'
    if (!window.confirm(`确定删除「${title}」吗？相关前置条件也会同步清理。`)) {
      return
    }
    const next = tasks
      .filter((task) => task.id !== id)
      .map((task) => ({
        ...task,
        requirement: pruneRequirement(
          task.requirement.map((group) => group.filter((item) => item !== id)),
        ),
      }))
    const result = revalidateTasks(next)
    setTasks(result.tasks)
    if (selectedId === id) setSelectedId(null)
    notify('任务已删除', 'ok')
  }

  function resetProgress() {
    if (!window.confirm('确定清空所有任务的完成进度吗？此操作不可撤销。')) {
      return
    }
    setTasks((prev) => prev.map((task) => ({ ...task, completed: false })))
    notify('已清空全部完成进度', 'ok')
  }

  function clearAllTasks() {
    if (!window.confirm('确定清空所有任务数据吗？所有节点、前置条件与完成进度都会被删除，且不可撤销。')) {
      return
    }
    setTasks([])
    setSelectedId(null)
    setDraggingId(null)
    setDragOverId(null)
    setDropHint(null)
    notify('已清空所有任务数据', 'ok')
  }

  function formatTree() {
    if (tasks.length === 0) return
    const next = formatLayout(tasks)
    if (next === tasks) {
      notify('当前布局已按层级排列', 'ok')
      return
    }
    setTasks(next)
    setDropHint(null)
    setDraggingId(null)
    setDragOverId(null)
    notify('已按依赖层级从左到右重新排列', 'ok')
  }

  function restoreDemo() {
    if (!window.confirm('恢复示例数据会覆盖当前全部任务与进度，确定继续吗？')) {
      return
    }
    setTasks(createDemoTasks())
    setTreeName(DEMO_TREE_NAME)
    setSelectedId(null)
    notify('已恢复示例数据', 'ok')
  }

  function exportData() {
    const blob = new Blob([stringifyExportFile(tasks, treeName)], {
      type: 'application/json;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `unlock-tree-${safeFileNamePart(treeName) || '未命名任务树'}-${formatDateStamp()}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    notify('任务数据已导出', 'ok')
  }

  async function importData(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      notify('导入失败：文件不能超过 5 MB', 'warn')
      return
    }

    try {
      const imported = parseTaskFile(await file.text())
      if (
        !window.confirm(
          `将导入「${imported.name || '未命名任务树'}」的 ${imported.tasks.length} 个任务并覆盖当前任务与进度，确定继续吗？`,
        )
      ) {
        return
      }
      setTasks(imported.tasks)
      setTreeName(imported.name)
      setSelectedId(null)
      notify(`已导入 ${imported.tasks.length} 个任务`, 'ok')
    } catch (error) {
      notify(
        `导入失败：${error instanceof Error ? error.message : '文件内容无法识别'}`,
        'warn',
      )
    }
  }

  function isSameLayer(a: string, b: string) {
    const from = layout.positions.get(a)
    const to = layout.positions.get(b)
    return Boolean(from && to && from.x === to.x)
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>, id: string) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
    setDraggingId(id)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, targetId: string) {
    if (
      !draggingId ||
      draggingId === targetId ||
      !isSameLayer(draggingId, targetId)
    ) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dragOverId !== targetId) setDragOverId(targetId)
  }

  /**
   * 落位语义：
   * - 同列落在节点上 → 与目标交换槽位；
   * - 同列落在空白处 → 移到该槽位，原槽位留空，其他节点不动；
   * - 跨列 → 只改变展示列与槽位，前置条件不变。
   */
  function getDropTarget(
    event: DragEvent<HTMLDivElement>,
    sourceId: string,
  ): {
    target:
      | { kind: 'swap'; taskId: string }
      | { kind: 'move'; slot: number }
      | { kind: 'position'; column: number; slot: number }
    x: number
    y: number
  } | null {
    // 以画布为坐标基准：拖到画布下方尚未被槽位占据的空白区也要能落位
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    // 画布经过缩放，屏幕坐标需换算回未缩放的逻辑坐标
    const mouseX = (event.clientX - rect.left) / zoom
    const mouseY = (event.clientY - rect.top) / zoom
    const layers = getLayers(tasks)
    if (layers.length === 0) return null

    const source = byId.get(sourceId)
    const sourceLayerIndex = layers.findIndex((layer) =>
      layer.some((task) => task.id === sourceId),
    )
    if (!source || sourceLayerIndex < 0) return null

    // 按列几何直接计算目标列：列可能为空，不能依赖 layer[0] 取坐标
    // 左右都不设限，允许拖到负数列和负槽位，即四周留白区域
    const columnStep = NODE_W + GAP_X
    const columnOffset = Math.round(
      (mouseX - PAD - NODE_W / 2) / columnStep,
    )
    const targetColumn = layout.minColumn + columnOffset

    const slotOffset = Math.round(
      (mouseY - PAD - NODE_H / 2) / (NODE_H + GAP_Y),
    )
    const slot = layout.minSlot + slotOffset
    const x = PAD + columnOffset * columnStep
    const y = PAD + slotOffset * (NODE_H + GAP_Y)

    if (columnOffset !== sourceLayerIndex) {
      // 跨列只记录展示位置，前置条件保持不变
      return {
        target: { kind: 'position', column: targetColumn, slot },
        x,
        y,
      }
    }

    const layer = layers[columnOffset] ?? []
    for (const task of layer) {
      if (task.id === sourceId) continue
      const pos = layout.positions.get(task.id)
      if (
        pos &&
        mouseX >= pos.x &&
        mouseX <= pos.x + NODE_W &&
        mouseY >= pos.y &&
        mouseY <= pos.y + NODE_H
      ) {
        return {
          target: { kind: 'swap', taskId: task.id },
          x: pos.x,
          y: pos.y,
        }
      }
    }

    if (slot === source.slot) return null

    const occupant = layer.find(
      (task) => task.id !== sourceId && task.slot === slot,
    )
    if (occupant) {
      const pos = layout.positions.get(occupant.id)
      return {
        target: { kind: 'swap', taskId: occupant.id },
        x: pos?.x ?? x,
        y: pos?.y ?? y,
      }
    }

    return { target: { kind: 'move', slot }, x, y }
  }

  function handleCanvasDragOver(event: DragEvent<HTMLDivElement>) {
    if (!draggingId) return
    const result = getDropTarget(event, draggingId)
    if (!result) {
      event.dataTransfer.dropEffect = 'none'
      if (dropHint) setDropHint(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (
      !dropHint ||
      dropHint.x !== result.x ||
      dropHint.y !== result.y ||
      dropHint.kind !== result.target.kind
    ) {
      setDropHint({
        x: result.x,
        y: result.y,
        kind: result.target.kind,
      })
    }
  }

  function handleCanvasDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    const sourceId = event.dataTransfer.getData('text/plain') || draggingId
    const result = sourceId ? getDropTarget(event, sourceId) : null
    setDraggingId(null)
    setDragOverId(null)
    setDropHint(null)

    if (!sourceId || !result) {
      if (sourceId) notify('无法放置到这里：位置无效', 'warn')
      return
    }

    const target = result.target
    const next =
      target.kind === 'swap'
        ? swapSlots(tasks, sourceId, target.taskId)
        : target.kind === 'move'
          ? moveToSlot(tasks, sourceId, target.slot)
          : moveToPosition(tasks, sourceId, target.column, target.slot)
    if (next === tasks) return

    setTasks(next)
    notify(
      target.kind === 'swap'
        ? '已与目标节点交换位置'
        : target.kind === 'position'
          ? '已移动到新位置'
          : '已移动到空白槽位',
      'ok',
    )
  }

  function handleDragEnd() {
    setDraggingId(null)
    setDragOverId(null)
    setDropHint(null)
  }

  function moveSelected(direction: -1 | 1) {
    if (!selected || !selectedId) return
    const targetSlot = selectedSlot + direction
    const layer =
      getLayers(tasks).find((group) =>
        group.some((task) => task.id === selectedId),
      ) ?? []
    const occupant = layer.find(
      (task) => task.slot === targetSlot && task.id !== selectedId,
    )
    const next = occupant
      ? swapSlots(tasks, selectedId, occupant.id)
      : moveToSlot(tasks, selectedId, targetSlot)
    if (next !== tasks) {
      setTasks(next)
      notify(
        occupant
          ? '已与目标节点交换位置'
          : direction === -1
            ? '已上移到空位'
            : '已下移到空位',
        'ok',
      )
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <div className="brand-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="2" y="9" width="6" height="6" rx="1.5" />
              <rect x="16" y="3" width="6" height="6" rx="1.5" />
              <rect x="16" y="15" width="6" height="6" rx="1.5" />
              <path d="M8 12h3c1.8 0 1.5-6 5-6M8 12h3c1.8 0 1.5 6 5 6" />
            </svg>
          </div>
          <div>
            <h1>UnlockTree · 任务解锁树</h1>
            <p>用前置条件驱动的任务解锁与级联校验</p>
          </div>
        </div>

        <div className="header-actions">
          <div className="stats">
            <div className="stat">
              <strong>{doneCount}</strong>
              <span>已完成</span>
            </div>
            <div className="stat">
              <strong>{readyCount}</strong>
              <span>可开始</span>
            </div>
            <div className="stat">
              <strong>{lockedCount}</strong>
              <span>未解锁</span>
            </div>
          </div>
          <button type="button" className="btn" onClick={exportData}>
            导出数据
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => importInputRef.current?.click()}
          >
            导入数据
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={importData}
          />
          {isEditing && (
            <>
              <button type="button" className="btn primary" onClick={addTask}>
                + 新增任务
              </button>
              <button
                type="button"
                className="btn"
                onClick={formatTree}
                disabled={tasks.length === 0}
                title="清除手动位置，按依赖深度从左到右排列，同层保持当前上下顺序"
              >
                一键格式化
              </button>
              <button type="button" className="btn" onClick={restoreDemo}>
                恢复示例
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={resetProgress}
              >
                一键清空进度
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={clearAllTasks}
                disabled={tasks.length === 0}
                title="删除任务树中的所有节点，不可撤销"
              >
                清空所有任务
              </button>
            </>
          )}
          <button
            type="button"
            className={`btn mode-toggle ${isEditing ? 'editing' : ''}`}
            onClick={() => {
              setIsEditing((prev) => !prev)
              setDraggingId(null)
              setDragOverId(null)
              setDropHint(null)
            }}
          >
            {isEditing ? '编辑模式 · 点击切换预览' : '预览模式 · 点击切换编辑'}
          </button>
        </div>
      </header>

      <div className="rule-strip">
        <span className="rule-strip-title">解锁规则</span>
        {RULES.map((rule) => (
          <span className="rule-item" key={rule.name}>
            <b>{rule.name}</b>
            <em>{rule.desc}</em>
          </span>
        ))}
      </div>

      <div className="workspace">
        <section className="canvas-panel">
          <div className="panel-head">
            {isEditing ? (
              <label className="tree-name-field">
                <span>任务树名称</span>
                <input
                  value={treeName}
                  maxLength={60}
                  placeholder="未命名任务树"
                  onChange={(event) => setTreeName(event.target.value)}
                />
              </label>
            ) : (
              <h2>{treeName.trim() || '任务树'}</h2>
            )}
            <span className="panel-hint">
              {isEditing
                ? '点击节点查看详情 · 同列拖动交换/落位，跨列拖动仅改变位置 · 滚轮缩放，拖拽空白处平移'
                : '预览模式 · 点击节点查看详情 · 滚轮缩放，拖拽空白处平移；切换到编辑模式后可修改'}
            </span>
            <div className="zoom-controls">
              <button
                type="button"
                title="缩小"
                aria-label="缩小任务树"
                disabled={zoom <= MIN_ZOOM}
                onClick={() => changeZoom(-ZOOM_STEP)}
              >
                −
              </button>
              <button
                type="button"
                className="zoom-level"
                title="重置为 100%"
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                title="放大"
                aria-label="放大任务树"
                disabled={zoom >= MAX_ZOOM}
                onClick={() => changeZoom(ZOOM_STEP)}
              >
                +
              </button>
              <button
                type="button"
                className="zoom-fit"
                title="缩放至适合窗口"
                onClick={fitZoom}
              >
                适应
              </button>
            </div>
          </div>

          <div
            ref={canvasScrollRef}
            className={`canvas-scroll${isPanning ? ' is-panning' : ''}`}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={handleCanvasPointerEnd}
            onPointerCancel={handleCanvasPointerEnd}
            onDragOver={handleCanvasDragOver}
            onDrop={handleCanvasDrop}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setDropHint(null)
              }
            }}
            onClick={(event) => {
              if (suppressBlankClickRef.current) {
                suppressBlankClickRef.current = false
                return
              }
              // 点击任务节点以外的空白区域时关闭任务详情
              if (!(event.target as HTMLElement).closest('.task-node')) {
                setSelectedId(null)
              }
            }}
          >
            <div
              className="canvas-stage"
              style={{
                width: canvasWidth + CANVAS_MARGIN * 2,
                height: canvasHeight + CANVAS_MARGIN * 2,
              }}
            >
              <div
                ref={canvasRef}
                className="canvas"
                style={{
                  position: 'absolute',
                  left: CANVAS_MARGIN,
                  top: CANVAS_MARGIN,
                  width: canvasWidth,
                  height: canvasHeight,
                  zoom,
                }}
              >
              {tasks.length === 0 && (
                <div className="canvas-empty">
                  <div className="canvas-empty-mark" aria-hidden="true">＋</div>
                  <p>任务树是空的</p>
                  <span>切换到编辑模式后，点击「+ 新增任务」开始搭建</span>
                </div>
              )}
              {dropHint && (
                <div
                  className={`drop-hint ${dropHint.kind}`}
                  style={{
                    left: dropHint.x,
                    top: dropHint.y,
                    width: NODE_W,
                    height: NODE_H,
                  }}
                >
                  {dropHint.kind === 'swap'
                    ? '交换位置'
                    : dropHint.kind === 'position'
                      ? '移动到此位置'
                      : '放置在此空位'}
                </div>
              )}
              <svg
                className="edge-layer"
                width={layout.width}
                height={layout.height}
                aria-hidden="true"
              >
                <defs>
                  <marker id="arrow-idle" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M0 0 L8 4 L0 8 z" fill="#c9d2e3" />
                  </marker>
                  <marker id="arrow-done" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M0 0 L8 4 L0 8 z" fill="#22a06b" />
                  </marker>
                </defs>
                {edges.map((edge) => {
                  const from = layout.positions.get(edge.from)
                  const to = layout.positions.get(edge.to)
                  if (!from || !to) return null
                  const x1 = from.x + NODE_W
                  const y1 = from.y + NODE_H / 2
                  const x2 = to.x
                  const y2 = to.y + NODE_H / 2
                  const mid = (x1 + x2) / 2
                  return (
                    <path
                      key={`${edge.from}-${edge.to}`}
                      d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                      className={`edge ${done.has(edge.from) ? 'done' : ''} ${
                        edge.optional ? 'optional' : ''
                      }`}
                      markerEnd={
                        done.has(edge.from) ? 'url(#arrow-done)' : 'url(#arrow-idle)'
                      }
                    />
                  )
                })}
              </svg>

              {tasks.map((task) => {
                const pos = layout.positions.get(task.id)
                if (!pos) return null
                const unlocked = isRequirementMet(task.requirement, done)
                const status = task.completed
                  ? 'done'
                  : unlocked
                    ? 'ready'
                    : 'locked'
                const reqText = describeRequirement(task.requirement, titleOf)

                return (
                  <div
                    key={task.id}
                    className={`task-node ${status} ${
                      selectedId === task.id ? 'selected' : ''
                    } ${draggingId === task.id ? 'dragging' : ''} ${
                      dragOverId === task.id ? 'drag-over' : ''
                    }`}
                    style={{ left: pos.x, top: pos.y, width: NODE_W, height: NODE_H }}
                    role="button"
                    tabIndex={0}
                    draggable={isEditing}
                    onClick={() => setSelectedId(task.id)}
                    onDragStart={(event) => handleDragStart(event, task.id)}
                    onDragOver={(event) => handleDragOver(event, task.id)}
                    onDragLeave={() =>
                      setDragOverId((prev) => (prev === task.id ? null : prev))
                    }
                    onDragEnd={handleDragEnd}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelectedId(task.id)
                      }
                    }}
                  >
                    <div className="node-row">
                      {isEditing && (
                        <span className="drag-handle" title="拖拽调整同层顺序">
                          <svg viewBox="0 0 10 16" fill="currentColor">
                            <circle cx="2.5" cy="3" r="1.2" />
                            <circle cx="7.5" cy="3" r="1.2" />
                            <circle cx="2.5" cy="8" r="1.2" />
                            <circle cx="7.5" cy="8" r="1.2" />
                            <circle cx="2.5" cy="13" r="1.2" />
                            <circle cx="7.5" cy="13" r="1.2" />
                          </svg>
                        </span>
                      )}
                      <span className="status-dot">
                        {task.completed ? '✓' : unlocked ? '●' : '○'}
                      </span>
                      <span className="node-status">
                        {task.completed ? '已完成' : unlocked ? '可开始' : '未解锁'}
                      </span>
                      <span className="node-id">槽位 {task.slot}</span>
                    </div>
                    <div className="node-title">{task.title}</div>
                    <div className="node-req" title={reqText}>
                      {reqText}
                    </div>
                    <div className="node-bottom">
                      <div className="node-badges">
                        {(patterns.get(task.id) ?? [])
                          .slice(0, 2)
                          .map((pattern) => (
                            <span className="badge" key={pattern}>
                              {pattern}
                            </span>
                          ))}
                      </div>
                      <button
                        type="button"
                        className="node-btn"
                        disabled={!task.completed && !unlocked}
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleTask(task.id)
                        }}
                      >
                        {task.completed ? '撤销' : '完成'}
                      </button>
                    </div>
                  </div>
                )
              })}
              </div>
            </div>
          </div>

          <div className="legend">
            <span className="legend-item">
              <i className="legend-dot done" /> 已完成
            </span>
            <span className="legend-item">
              <i className="legend-dot ready" /> 可开始
            </span>
            <span className="legend-item">
              <i className="legend-dot locked" /> 未解锁
            </span>
            <span className="legend-divider" />
            <span className="legend-item">
              <i className="legend-line solid" /> 必须条件
            </span>
            <span className="legend-item">
              <i className="legend-line dashed" /> 可选条件（或）
            </span>
          </div>
        </section>

        {selected && (
          <aside className="inspector">
            <div className="inspector-head">
              <div className="inspector-title-row">
                <span className="eyebrow">
                  任务详情 · {isEditing ? '编辑模式' : '预览模式'}
                </span>
                <button
                  type="button"
                  className="inspector-close"
                  title="关闭任务详情"
                  onClick={() => setSelectedId(null)}
                >
                  ×
                </button>
              </div>
              <h2>{selected.title}</h2>
              <span
                className={`pill ${
                    selected.completed
                      ? 'done'
                      : isRequirementMet(selected.requirement, done)
                        ? 'ready'
                        : 'locked'
                  }`}
                >
                  {selected.completed
                    ? '已完成'
                    : isRequirementMet(selected.requirement, done)
                      ? '可开始'
                      : '未解锁'}
              </span>
            </div>

            <div className="inspector-body">
              {isEditing ? (
                <>
                  <label className="field">
                    <span>任务名称</span>
                    <input
                      value={selected.title}
                      onChange={(event) => {
                        const title = event.target.value
                        setTasks((prev) =>
                          prev.map((task) =>
                            task.id === selected.id ? { ...task, title } : task,
                          ),
                        )
                      }}
                    />
                  </label>

                  <label className="field">
                    <span>备注</span>
                    <textarea
                      rows={3}
                      value={selected.note}
                      placeholder="补充说明这个任务..."
                      onChange={(event) => {
                        const note = event.target.value
                        setTasks((prev) =>
                          prev.map((task) =>
                            task.id === selected.id ? { ...task, note } : task,
                          ),
                        )
                      }}
                    />
                  </label>
                </>
              ) : (
                <div className="detail-block">
                  <span className="detail-label">任务说明</span>
                  <p className="detail-text">
                    {selected.note || '暂无说明'}
                  </p>
                </div>
              )}

              {isEditing && (
              <div className="order-controls">
                <div>
                  <b>上下顺序</b>
                  <span>
                    槽位 {selectedSlot} · 同层 {selectedLayerIds.length} 项
                  </span>
                </div>
                <div className="order-buttons">
                  <button
                    type="button"
                    onClick={() => moveSelected(-1)}
                  >
                    ↑ 上移
                  </button>
                  <button type="button" onClick={() => moveSelected(1)}>
                    ↓ 下移
                  </button>
                </div>
              </div>
              )}

              <div className="divider" />

              <div className="section-title">
                <h3>前置条件</h3>
                <span>组间「且」 · 组内「或」</span>
              </div>

              {isEditing ? (
                <RequirementEditor
                  key={`${selected.id}-${JSON.stringify(selected.requirement)}`}
                  task={selected}
                  tasks={tasks}
                  onSave={(requirement) =>
                    updateRequirement(selected.id, requirement)
                  }
                />
              ) : (
                <RequirementPreview task={selected} tasks={tasks} />
              )}

              <div className="divider" />

              <div className="cascade-note">
                <b>级联校验</b>
                <p>
                  撤销已完成任务或修改前置条件后，系统会自动重新检查所有已完成任务；
                  一旦后置任务缺失完成条件，也会同步改为未完成。
                </p>
              </div>
            </div>

            {isEditing && (
              <div className="inspector-footer">
                <button
                  type="button"
                  className="delete-btn"
                  onClick={() => deleteTask(selected.id)}
                >
                  删除此任务
                </button>
              </div>
            )}
          </aside>
      )}
      </div>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
