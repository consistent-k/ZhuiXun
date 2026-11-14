/**
 * 上下文压缩摘要器：把早期对话转写成一段摘要文本。范式对齐 `features/conversations/title-generator`：
 * 复用同一 provider 通道（{@link createModel}）、best-effort（失败/超时/空返回一律 null，调用方降级，绝不抛错）。
 * 领域无关：忠实保留关键事实、数据与待办，不新增结论、不编造。
 */
import { generateText } from 'ai';

import { createModel } from '@/agent/model/provider';
import type { ResolvedModel } from '@/config/types';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('ContextCompaction');

/** 摘要输出上限：推理型模型会先吃输出预算做思考，预算过小会导致正文为空，故放宽。 */
const SUMMARY_MAX_OUTPUT_TOKENS = 2048;

const SUMMARY_SYSTEM_PROMPT =
    '你是 AI 助手的「对话上下文压缩器」。你的任务是把较早的对话忠实压缩成一段摘要，供后续对话延续时作为背景。' +
    '必须保留：关键事实与背景信息、已达成的结论与决定、尚未解决的问题与待办、' +
    '用户明确表达的偏好与要求、关键工具调用得到的事实结论、已生成或修改的文件路径。可省略：寒暄、重复、过程性措辞。' +
    '名称、数值与单位、日期时间等关键数据必须原样保留，不得四舍五入、换算或概括成定性描述。' +
    '要求：用简洁条理的中文，可用小标题或要点列表；只做忠实摘要，不得编造未出现的信息，不得补充对话中没有的新结论或建议。' +
    '若已提供「已有摘要」，请把新的对话记录并入其中，输出一份更新后的完整摘要，而非增量。';

/**
 * 生成/更新上下文摘要。
 *
 * @param transcript 需要并入摘要的对话转写文本（通常是早期消息）
 * @param previousSummary 已有摘要（滚动压缩时并入）；无则传 undefined
 * @param model 已解析的模型配置（含密钥）
 * @param instructions 用户手动压缩时附带的保留要点（可选）
 * @returns 摘要文本；不可用（失败/空）时为 null
 */
export async function generateCompactionSummary(
    transcript: string,
    previousSummary: string | undefined,
    model: ResolvedModel,
    instructions?: string
): Promise<string | null> {
    const trimmed = transcript.trim();
    if (!trimmed) return null;
    // 用户经 /compact 给出的保留要点：作为额外要求附在末尾，不替换系统提示里的忠实摘要约束
    const extra = instructions?.trim() ? `\n\n【用户对本次摘要的额外要求】\n${instructions.trim()}` : '';
    const prompt =
        (previousSummary ? `【已有摘要】\n${previousSummary}\n\n` : '') +
        `【需要并入摘要的对话记录】\n${trimmed}${extra}\n\n请输出更新后的完整摘要。`;
    try {
        const { text } = await generateText({
            model: createModel(model),
            instructions: SUMMARY_SYSTEM_PROMPT,
            prompt,
            maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
            temperature: 0.3
        });
        const out = (text ?? '').trim();
        if (!out) {
            log.warn('摘要生成结果为空，放弃本轮压缩');
            return null;
        }
        return out;
    } catch (err) {
        log.warn('摘要生成失败，放弃本轮压缩', { err });
        return null;
    }
}
