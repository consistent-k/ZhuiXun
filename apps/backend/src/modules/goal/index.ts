/** goal 模块公开契约：进程本地自驱循环的武装/解除/推进。模块外只从这里 import。 */
export { getGoalService, setGoalService } from './registry';
export { GoalService, MAX_GOAL_ROUNDS, type GoalRecord, type GoalServiceDeps, type GoalTurnEndEvent } from './service';
