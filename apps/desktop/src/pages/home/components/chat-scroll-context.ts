import { createContext } from 'react';

/** ChatTranscript 下发给消息内子组件的滚动控制 */
export interface ChatScrollControl {
    /**
     * 用户手动展开 / 收起可折叠块（思考过程、工具详情）时调用：解除贴底跟随，
     * 避免流式自动滚动把刚操作的内容推出视口。用户再滚回底部会自动恢复跟随。
     */
    stopScroll: () => void;
}

export const ChatScrollContext = createContext<ChatScrollControl>({ stopScroll: () => {} });
