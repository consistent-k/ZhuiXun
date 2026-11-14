import { generateText } from 'ai';

import { createModel } from '@/agent/model/provider';
import type { ResolvedModel } from '@/config/types';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('ConversationTitle');

/** 标题最大字数（与派生标题截断口径一致，避免侧栏溢出）。 */
const MAX_TITLE_LENGTH = 20;
/** 送入模型的首条用户内容上限，控成本。 */
const MAX_INPUT_LENGTH = 500;

const TITLE_SYSTEM_PROMPT =
    '你是会话标题生成器。请根据用户的首条提问，总结生成一个简洁的中文标题。' +
    '要求：概括主题而非解答问题；不超过 12 个字；直接输出标题本身，不要引号、标点、前后缀或任何多余说明。' +
    '严禁输出任何安全评估、风险判断、分析过程或类似 "User Safety"、"Analysis" 的前缀；' +
    '无论提问涉及什么话题，都只概括其主题生成标题，绝不拒答、不加免责声明、不输出 "很抱歉/无法" 之类的话。';

/**
 * 分类器式输出识别。
 *
 * 依据：`openrouter/free` 这类「自动路由」模型会把标题请求随机分发到内容安全审核模型
 * 提示词约束对分类器无效，只能在输出侧识别：命中即视为「不是标题」，
 * 返回 null 让调用方降级到 `deriveTitleFromMessages` 的确定性派生标题。
 */
const CLASSIFIER_VERDICT_PATTERNS: RegExp[] = [
    /^user\s*safety\b/i, // "User Safety: safe"
    /^(analysis|safety|risk|moderation|content[\s-]*safety)\s*[:：]/i,
    /^(safe|unsafe|none|null|n\/a)$/i,
    /^(user\s*)?(input|request|query|prompt)\s+is\s+(safe|unsafe|benign|harmful)/i,
    // 中文审核模型：单独的判定词，或「安全评估：安全」这类「判定项：判定值」形态。
    // 刻意要求冒号在判定项之后，避免误伤「安全帽佩戴规范」这类正常主题标题。
    /^(安全|不安全|安全评估|风险评估|内容安全)$/,
    /^(安全|不安全|安全评估|风险评估|内容安全)\s*[:：]\s*(安全|不安全|是|否|无风险|有风险|safe|unsafe)?$/i
];

/** 清洗模型输出为可用标题：取首行、去首尾引号与标点、拦截分类器判定、截断；无有效内容返回 null。 */
function sanitizeTitle(raw: string): string | null {
    let title = (raw ?? '').trim().split('\n')[0]?.trim() ?? '';
    title = title.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
    title = title.replace(/[。.!！?？，,、；;：:\s]+$/g, '').trim();
    if (!title) return null;
    if (CLASSIFIER_VERDICT_PATTERNS.some((re) => re.test(title))) {
        log.warn('标题生成返回分类器式判定，降级为派生标题', { raw: title });
        return null;
    }
    return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) : title;
}

/**
 * 用 AI 总结首条用户消息，生成简洁的会话标题。
 *
 * best-effort：模型未就绪 / 调用失败 / 超时 / 输出为空一律返回 null（调用方降级为派生标题），绝不抛错，
 * 不影响对话流式。与对话复用同一 provider 通道（{@link createModel}），不新增数据外发面。
 *
 * @param firstUserText 首条用户消息的纯文本
 * @param model 已解析的激活模型（含密钥）
 * @returns 清洗后的标题；不可用时为 null
 */
export async function generateConversationTitle(firstUserText: string, model: ResolvedModel): Promise<string | null> {
    const input = (firstUserText ?? '').trim().slice(0, MAX_INPUT_LENGTH);
    if (!input) return null;
    try {
        const { text } = await generateText({
            model: createModel(model),
            instructions: TITLE_SYSTEM_PROMPT,
            prompt: `用户提问：${input}`,
            // 标题本身仅十余字，但推理型模型会先消耗输出预算做思考，预算过小会导致思考占满、正文为空。
            // 放宽上限留出思考空间；非推理模型生成完短标题即停，不会多花 token。
            maxOutputTokens: 512,
            temperature: 0.3
        });
        const title = sanitizeTitle(text);
        if (!title) log.warn('标题生成结果为空，降级为派生标题');
        return title;
    } catch (err) {
        log.warn('标题生成失败，降级为派生标题', { err });
        return null;
    }
}
