import { pruneRequirement, revalidateTasks } from './taskEngine.ts'
import type { Requirement, Task } from './types.ts'

export const EXPORT_VERSION = 1

export interface TaskFile {
  version: number
  exportedAt: string
  tasks: Task[]
}

/** 导出内容包含任务定义、前置条件、槽位与完成进度 */
export function buildExportFile(tasks: Task[]): TaskFile {
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    tasks,
  }
}

export function stringifyExportFile(tasks: Task[]): string {
  return JSON.stringify(buildExportFile(tasks), null, 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseRequirement(value: unknown): Requirement | null {
  if (!Array.isArray(value)) return null
  const groups: Requirement = []
  for (const group of value) {
    if (!Array.isArray(group) || !group.every((id) => typeof id === 'string')) {
      return null
    }
    groups.push([...group])
  }
  return groups
}

/** 检查导入数据中是否存在循环依赖 */
function hasCycle(tasks: Task[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const state = new Map<string, 1 | 2>()

  function visit(id: string): boolean {
    if (state.get(id) === 1) return true
    if (state.get(id) === 2) return false
    state.set(id, 1)
    const task = byId.get(id)
    for (const prereq of new Set(task?.requirement.flat() ?? [])) {
      if (byId.has(prereq) && visit(prereq)) return true
    }
    state.set(id, 2)
    return false
  }

  return tasks.some((task) => visit(task.id))
}

/**
 * 解析导入的 JSON：既接受本应用导出的文件，也接受纯任务数组。
 * 会清理悬空前置条件、重复 ID 与非法槽位，并校验循环依赖。
 */
export function parseTaskFile(text: string): Task[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是有效的 JSON 文件')
  }

  const source = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? parsed.tasks
      : null
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error('文件中没有任务数据')
  }

  const usedIds = new Set<string>()
  const tasks: Task[] = source.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`第 ${index + 1} 项任务格式无效`)
    if (typeof raw.id !== 'string' || raw.id.trim() === '') {
      throw new Error(`第 ${index + 1} 项任务缺少有效 id`)
    }
    const requirement = parseRequirement(raw.requirement)
    if (!requirement) throw new Error(`任务「${raw.id}」的前置条件格式无效`)

    let id = raw.id
    if (usedIds.has(id)) {
      let suffix = 2
      while (usedIds.has(`${raw.id}-${suffix}`)) suffix++
      id = `${raw.id}-${suffix}`
    }
    usedIds.add(id)

    return {
      id,
      title: typeof raw.title === 'string' && raw.title ? raw.title : id,
      note: typeof raw.note === 'string' ? raw.note : '',
      requirement,
      completed: raw.completed === true,
      slot:
        typeof raw.slot === 'number' && Number.isFinite(raw.slot)
          ? Math.max(0, Math.floor(raw.slot))
          : index,
    }
  })

  const validIds = new Set(tasks.map((task) => task.id))
  const sanitized = tasks.map((task) => ({
    ...task,
    requirement: pruneRequirement(
      task.requirement.map((group) => group.filter((id) => validIds.has(id))),
    ),
  }))

  if (hasCycle(sanitized)) {
    throw new Error('任务之间存在循环依赖，无法导入')
  }

  return revalidateTasks(sanitized).tasks
}
