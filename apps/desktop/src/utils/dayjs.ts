/**
 * 统一的 dayjs 实例：集中注册插件与中文语言包，供前端各处时间处理复用，
 * 避免各文件各自手写时间格式化/相对时间逻辑。import 本模块而非直接 import 'dayjs'。
 */
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

export default dayjs;
