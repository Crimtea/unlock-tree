import type { Edge, Layout, Pattern, Point, Requirement, Task } from './types'

export const NODE_W = 212
export const NODE_H = 118
export const GAP_X = 84
/** 同层节点之间的垂直间距（保持空槽可见，同时比节点高度更紧凑） */
export const GAP_Y = 48
export const PAD = 36

/** 条件是否满足：所有条件组都满足（且），组内任意一个任务完成即可（或） */
export function isRequirementMet(
  requirement: Requirement,
  completed: Set<string>,
): boolean {
  return requirement.every((group) => group.some((id) => completed.has(id)))
}

export function completedIdSet(tasks: Task[]): Set<string> {
  return new Set(tasks.filter((task) => task.completed).map((task) => task.id))
}

export function pruneRequirement(requirement: Requirement): Requirement {
  return requirement
    .map((group) => [...new Set(group)])
    .filter((group) => group.length > 0)
}

/** 规整槽位：非法值归零，同层冲突时把后来者顺延到空槽 */
export function normalizeSlots(tasks: Task[]): Task[] {
  const result = tasks.map((task) => ({
    ...task,
    slot: Number.isFinite(task.slot) ? Math.floor(task.slot) : 0,
  }))
  let changed = result.some((task, index) => task.slot !== tasks[index].slot)

  for (const layer of getLayers(result)) {
    const used = new Set<number>()
    for (const task of layer) {
      let slot = task.slot
      if (used.has(slot)) {
        while (used.has(slot)) slot++
        task.slot = slot
        changed = true
      }
      used.add(slot)
    }
  }
  return changed ? result : tasks
}

/** 交换同层两个任务的槽位 */
export function swapSlots(
  tasks: Task[],
  firstId: string,
  secondId: string,
): Task[] {
  const first = tasks.find((task) => task.id === firstId)
  const second = tasks.find((task) => task.id === secondId)
  if (!first || !second || firstId === secondId) return tasks
  return tasks.map((task) =>
    task.id === firstId
      ? { ...task, slot: second.slot }
      : task.id === secondId
        ? { ...task, slot: first.slot }
        : task,
  )
}

/** 把任务移到固定槽位；原槽位留空，其他任务不动 */
export function moveToSlot(tasks: Task[], taskId: string, slot: number): Task[] {
  const task = tasks.find((item) => item.id === taskId)
  if (!task || task.slot === slot) return tasks
  return tasks.map((item) => (item.id === taskId ? { ...item, slot } : item))
}

/** 交换两个任务的展示位置（列与槽位），前置条件与完成状态不变 */
export function swapPositions(
  tasks: Task[],
  firstId: string,
  secondId: string,
): Task[] {
  const first = tasks.find((task) => task.id === firstId)
  const second = tasks.find((task) => task.id === secondId)
  if (!first || !second || firstId === secondId) return tasks

  const depths = getDependencyDepths(tasks)
  const displayColumn = (task: Task) =>
    typeof task.column === 'number' && Number.isFinite(task.column)
      ? Math.floor(task.column)
      : (depths.get(task.id) ?? 0)
  const firstColumn = displayColumn(first)
  const secondColumn = displayColumn(second)
  if (firstColumn === secondColumn && first.slot === second.slot) return tasks

  const apply = (task: Task, column: number, slot: number): Task => {
    const next = { ...task, slot }
    // 回到依赖深度对应的列时移除手动覆盖，恢复自动布局
    if (column === (depths.get(task.id) ?? 0)) delete next.column
    else next.column = column
    return next
  }

  return tasks.map((task) => {
    if (task.id === firstId) return apply(task, secondColumn, second.slot)
    if (task.id === secondId) return apply(task, firstColumn, first.slot)
    return task
  })
}

/** 仅改变任务的展示位置（列与槽位），不修改前置条件 */
export function moveToPosition(
  tasks: Task[],
  taskId: string,
  column: number,
  slot: number,
): Task[] {
  const task = tasks.find((item) => item.id === taskId)
  if (!task) return tasks
  const depth = getDependencyDepths(tasks).get(taskId) ?? 0
  // 拖回自然依赖列时移除覆盖，恢复自动布局
  const nextColumn = column === depth ? undefined : column
  if (task.slot === slot && task.column === nextColumn) return tasks
  return tasks.map((item) => {
    if (item.id !== taskId) return item
    const next = { ...item, slot }
    if (nextColumn === undefined) delete next.column
    else next.column = nextColumn
    return next
  })
}

/**
 * 一键整理：清除手动列覆盖，按依赖深度从左到右排列；
 * 同层节点保持当前上下顺序，槽位重新编号为连续非负整数。
 */
export function formatLayout(tasks: Task[]): Task[] {
  if (tasks.length === 0) return tasks
  const depths = getDependencyDepths(tasks)
  const groups = new Map<number, Task[]>()
  for (const task of tasks) {
    const depth = depths.get(task.id) ?? 0
    const group = groups.get(depth) ?? []
    group.push(task)
    groups.set(depth, group)
  }

  const slots = new Map<string, number>()
  for (const group of groups.values()) {
    group.sort((a, b) => slotOf(a) - slotOf(b))
    group.forEach((task, index) => slots.set(task.id, index))
  }

  const changed = tasks.some(
    (task) => task.column !== undefined || task.slot !== slots.get(task.id),
  )
  if (!changed) return tasks

  return tasks.map((task) => {
    const next = { ...task, slot: slots.get(task.id) ?? 0 }
    delete next.column
    return next
  })
}

/** 取某层末尾的新槽位（新增任务时使用） */
export function nextSlotInLayer(tasks: Task[], layerIds: string[]): number {
  let max = -1
  for (const id of layerIds) {
    const task = tasks.find((item) => item.id === id)
    if (task) max = Math.max(max, task.slot)
  }
  return max + 1
}

/**
 * 重新校验所有已完成任务：
 * 若某个已完成任务的前置条件不再成立，则将其改为未完成，并循环处理，
 * 直到没有任何已完成的任务条件缺失（级联撤销）。
 */
export function revalidateTasks(tasks: Task[]): {
  tasks: Task[]
  revoked: string[]
} {
  const next = normalizeSlots(tasks).map((task) => ({
    ...task,
    requirement: task.requirement.map((group) => [...group]),
  }))
  const revoked = new Set<string>()

  let changed = true
  while (changed) {
    changed = false
    const done = completedIdSet(next)
    for (const task of next) {
      if (task.completed && !isRequirementMet(task.requirement, done)) {
        task.completed = false
        revoked.add(task.id)
        changed = true
      }
    }
  }

  return { tasks: next, revoked: [...revoked] }
}

/** 检查把 requirement 设为 taskId 的前置条件是否会形成循环依赖 */
export function wouldCreateCycle(
  tasks: Task[],
  taskId: string,
  requirement: Requirement,
): boolean {
  const dependents = new Map<string, string[]>()
  for (const task of tasks) {
    for (const prereq of new Set(task.requirement.flat())) {
      const list = dependents.get(prereq) ?? []
      list.push(task.id)
      dependents.set(prereq, list)
    }
  }

  const newPrereqs = new Set(requirement.flat())
  if (newPrereqs.has(taskId)) return true

  const stack = [taskId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (seen.has(current)) continue
    seen.add(current)
    if (newPrereqs.has(current)) return true
    for (const next of dependents.get(current) ?? []) stack.push(next)
  }
  return false
}

export function describeRequirement(
  requirement: Requirement,
  titleOf: (id: string) => string,
): string {
  if (requirement.length === 0) return '起始任务 · 无前置条件'
  return requirement
    .map((group) =>
      group.length === 1
        ? titleOf(group[0])
        : `（${group.map(titleOf).join(' 或 ')}）`,
    )
    .join(' 且 ')
}

/** 按前置条件计算依赖深度，忽略拖动产生的手动列覆盖 */
export function getDependencyDepths(tasks: Task[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const depthCache = new Map<string, number>()

  const depthOf = (id: string, path: Set<string>): number => {
    if (depthCache.has(id)) return depthCache.get(id) as number
    if (path.has(id)) return 0

    const nextPath = new Set(path)
    nextPath.add(id)
    const task = byId.get(id)
    const prereqs = task
      ? [...new Set(task.requirement.flat())].filter((p) => byId.has(p))
      : []
    const depth =
      prereqs.length > 0
        ? Math.max(...prereqs.map((p) => depthOf(p, nextPath))) + 1
        : 0
    depthCache.set(id, depth)
    return depth
  }

  for (const task of tasks) depthOf(task.id, new Set())
  return depthCache
}

/** 展示列：手动 column 优先（可为负数），否则回退到依赖深度 */
function columnOf(task: Task, depths: Map<string, number>): number {
  return typeof task.column === 'number' && Number.isFinite(task.column)
    ? Math.floor(task.column)
    : (depths.get(task.id) ?? 0)
}

function slotOf(task: Task): number {
  return Number.isFinite(task.slot) ? Math.floor(task.slot) : 0
}

/** 按展示列分组：数组下标 = 实际列 - 最小列，因此包含负数列 */
export function getLayers(tasks: Task[]): Task[][] {
  const depths = getDependencyDepths(tasks)
  const minColumn = tasks.reduce(
    (min, task) => Math.min(min, columnOf(task, depths)),
    0,
  )
  const layers: Task[][] = []
  for (const task of tasks) {
    const index = columnOf(task, depths) - minColumn
    while (layers.length <= index) layers.push([])
    layers[index].push(task)
  }
  for (const layer of layers) layer.sort((a, b) => a.slot - b.slot)
  return layers
}

/** 按展示列分层布局，形成从左到右生长的树状 / 有向无环图 */
export function getLayout(tasks: Task[]): Layout {
  const depths = getDependencyDepths(tasks)
  const minColumn = tasks.reduce(
    (min, task) => Math.min(min, columnOf(task, depths)),
    0,
  )
  const minSlot = tasks.reduce((min, task) => Math.min(min, slotOf(task)), 0)
  const maxColumn = tasks.reduce(
    (max, task) => Math.max(max, columnOf(task, depths)),
    minColumn,
  )
  const maxSlot = tasks.reduce((max, task) => Math.max(max, slotOf(task)), minSlot)
  const columnCount = tasks.length > 0 ? maxColumn - minColumn + 1 : 0
  const slotCount = tasks.length > 0 ? maxSlot - minSlot + 1 : 1

  const positions = new Map<string, Point>()
  for (const task of tasks) {
    positions.set(task.id, {
      x: PAD + (columnOf(task, depths) - minColumn) * (NODE_W + GAP_X),
      y: PAD + (slotOf(task) - minSlot) * (NODE_H + GAP_Y),
    })
  }

  return {
    positions,
    width: PAD * 2 + columnCount * NODE_W + Math.max(0, columnCount - 1) * GAP_X,
    height: PAD * 2 + slotCount * NODE_H + Math.max(0, slotCount - 1) * GAP_Y,
    minColumn,
    minSlot,
  }
}

export function getEdges(tasks: Task[]): Edge[] {
  const edges: Edge[] = []
  for (const task of tasks) {
    const groupSizeOf = new Map<string, number>()
    for (const group of task.requirement) {
      for (const id of group) {
        groupSizeOf.set(id, Math.max(groupSizeOf.get(id) ?? 0, group.length))
      }
    }
    for (const [from, size] of groupSizeOf) {
      edges.push({ from, to: task.id, optional: size > 1 })
    }
  }
  return edges
}

/** 识别每个节点展示的解锁模式标签 */
export function getPatterns(tasks: Task[]): Map<string, Pattern[]> {
  const result = new Map<string, Pattern[]>()
  const add = (id: string, pattern: Pattern) => {
    const list = result.get(id) ?? []
    if (!list.includes(pattern)) list.push(pattern)
    result.set(id, list)
  }

  const singleDependents = new Map<string, number>()
  for (const task of tasks) {
    if (task.requirement.length === 1 && task.requirement[0].length === 1) {
      const prereq = task.requirement[0][0]
      singleDependents.set(prereq, (singleDependents.get(prereq) ?? 0) + 1)
    }
  }

  for (const task of tasks) {
    if ((singleDependents.get(task.id) ?? 0) >= 2) add(task.id, '一解锁多')

    const req = task.requirement
    if (req.length === 0) add(task.id, '起始任务')
    else if (req.length === 1 && req[0].length === 1) add(task.id, '一解锁一')
    else if (req.length === 1) add(task.id, '可选任务')
    else if (req.every((group) => group.length === 1)) add(task.id, '多解锁一')
    else add(task.id, '必须 + 可选')
  }

  return result
}
