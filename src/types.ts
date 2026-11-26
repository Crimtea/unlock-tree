/** 前置条件：外层数组之间为「且」，每个内层数组内部为「或」 */
export type Requirement = string[][]

export interface Task {
  id: string
  title: string
  note: string
  requirement: Requirement
  completed: boolean
  /** 同一依赖层内的固定槽位；槽位可以留空，节点不会自动补位 */
  slot: number
}

export interface Point {
  x: number
  y: number
}

export interface Layout {
  positions: Map<string, Point>
  width: number
  height: number
}

export interface Edge {
  from: string
  to: string
  optional: boolean
}

export type Pattern =
  | '起始任务'
  | '一解锁一'
  | '一解锁多'
  | '多解锁一'
  | '可选任务'
  | '必须 + 可选'
