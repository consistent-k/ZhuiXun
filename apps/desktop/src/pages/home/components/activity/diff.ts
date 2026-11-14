/** 行级 diff（LCS），只服务于会话内联 diff 展示；大文本按上限截断。 */

export type DiffLineType = 'add' | 'remove' | 'context';

export interface DiffLine {
    type: DiffLineType;
    text: string;
}

export interface DiffResult {
    lines: DiffLine[];
    additions: number;
    deletions: number;
    truncated: boolean;
}

/** 单侧最多参与 diff 的行数：200×200 的 DP 约 4 万次，足够覆盖常规编辑 */
const MAX_DIFF_LINES = 200;

function splitLines(text: string): string[] {
    if (!text) return [];
    return text.replace(/\r\n?/g, '\n').split('\n');
}

export function diffLines(oldText: string, newText: string): DiffResult {
    const oldAll = splitLines(oldText);
    const newAll = splitLines(newText);
    const truncated = oldAll.length > MAX_DIFF_LINES || newAll.length > MAX_DIFF_LINES;
    const a = oldAll.slice(0, MAX_DIFF_LINES);
    const b = newAll.slice(0, MAX_DIFF_LINES);
    const n = a.length;
    const m = b.length;

    // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const lines: DiffLine[] = [];
    let additions = 0;
    let deletions = 0;
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            lines.push({ type: 'context', text: a[i] });
            i += 1;
            j += 1;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            lines.push({ type: 'remove', text: a[i] });
            deletions += 1;
            i += 1;
        } else {
            lines.push({ type: 'add', text: b[j] });
            additions += 1;
            j += 1;
        }
    }
    while (i < n) {
        lines.push({ type: 'remove', text: a[i] });
        deletions += 1;
        i += 1;
    }
    while (j < m) {
        lines.push({ type: 'add', text: b[j] });
        additions += 1;
        j += 1;
    }

    return { lines, additions, deletions, truncated };
}

/** 只要计数时避免调用方再遍历一次 diff 结果 */
export function diffStats(oldText: string, newText: string): Pick<DiffResult, 'additions' | 'deletions' | 'truncated'> {
    const result = diffLines(oldText, newText);
    return { additions: result.additions, deletions: result.deletions, truncated: result.truncated };
}
