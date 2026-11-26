import type { Task } from './types'

/**
 * 示例项目：把 5 种解锁模式全部放进同一棵树里。
 * 条件组之间「且」，组内「或」。slot 为各层内的固定槽位。
 */
export function createDemoTasks(): Task[] {
  return [
    {
      id: 't1',
      title: '需求确认',
      note: '明确项目目标、范围与验收标准，作为整棵树的起点。',
      requirement: [],
      completed: true,
      slot: 0,
    },
    {
      id: 't2',
      title: '原型设计',
      note: '一解锁一：完成「需求确认」后解锁。',
      requirement: [['t1']],
      completed: false,
      slot: 0,
    },
    {
      id: 't3',
      title: '视觉设计',
      note: '一解锁多：与「原型设计」「技术方案」共同由「需求确认」解锁。',
      requirement: [['t1']],
      completed: false,
      slot: 1,
    },
    {
      id: 't4',
      title: '技术方案',
      note: '一解锁多：完成「需求确认」后即可开始。',
      requirement: [['t1']],
      completed: false,
      slot: 2,
    },
    {
      id: 't5',
      title: '前端开发',
      note: '多解锁一：需要「原型设计」且「视觉设计」都完成。',
      requirement: [['t2'], ['t3']],
      completed: false,
      slot: 0,
    },
    {
      id: 't6',
      title: '后端开发',
      note: '多解锁一：需要「视觉设计」且「技术方案」都完成。',
      requirement: [['t3'], ['t4']],
      completed: false,
      slot: 1,
    },
    {
      id: 't7',
      title: '文档编写',
      note: '可选任务：完成「原型设计」或「技术方案」任意一个即可解锁。',
      requirement: [['t2', 't4']],
      completed: false,
      slot: 2,
    },
    {
      id: 't8',
      title: '集成测试',
      note: '必须 + 可选：需要（前端开发 或 后端开发）且 文档编写。',
      requirement: [
        ['t5', 't6'],
        ['t7'],
      ],
      completed: false,
      slot: 0,
    },
    {
      id: 't9',
      title: '上线发布',
      note: '一解锁一：完成「集成测试」后解锁。',
      requirement: [['t8']],
      completed: false,
      slot: 0,
    },
  ]
}
