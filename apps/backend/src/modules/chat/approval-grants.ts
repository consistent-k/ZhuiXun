import { randomBytes } from 'node:crypto';

import { isValidConversationId } from '@/modules/conversations';

const grants = new Map<string, string>();

// 只有宿主进程能签发授权。HTTP 只能提交凭证，不能通过请求字段自行开启完全访问。
export const desktopApprovalGrants = {
    grant(sessionId: string): string {
        if (!isValidConversationId(sessionId)) throw new Error('非法会话 id');
        const token = randomBytes(32).toString('hex');
        grants.set(sessionId, token);
        return token;
    },
    revoke(sessionId: string): void {
        grants.delete(sessionId);
    },
    clear(): void {
        grants.clear();
    }
};

export function hasDesktopApprovalGrant(sessionId?: string, token?: string): boolean {
    return !!sessionId && !!token && grants.get(sessionId) === token;
}
