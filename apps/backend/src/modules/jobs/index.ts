/** jobs 模块公开契约：后台任务的入队/执行/取消与视图映射。模块外只从这里 import。 */
export {
    createJobService,
    getJobService,
    JobService,
    MAX_CONCURRENT_JOBS,
    setJobService,
    type JobServiceDeps
} from './service';
export { createJobStore, getJobStore, MAX_JOBS, toJobView, type JobRecord, type JobStore } from './store';
