import type { UIMessage } from 'ai';
import { useMemo } from 'react';

import { collectPendingInteractions, type PendingInteraction } from './pending';

/** 从消息流派生当前轮待确认项；空数组时调用方不渲染 dock。 */
export function usePendingInteractions(messages: UIMessage[]): PendingInteraction[] {
    return useMemo(() => collectPendingInteractions(messages), [messages]);
}
