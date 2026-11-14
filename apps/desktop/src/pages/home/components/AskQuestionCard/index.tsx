import { CheckCircleFilled, QuestionCircleOutlined } from '@ant-design/icons';
import type { AskUserQuestion, AskUserQuestionInput, AskUserQuestionOutput } from '@zhuixun/shared';
import { Alert, Button, Checkbox, Form, Input, Radio } from 'antd';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { useChatStore } from '@/stores/chatStore';

import { StreamingMarkdown } from '../StreamingMarkdown';

import {
    buildQuestionOutput,
    getAnswerError,
    getInputFingerprint,
    parseQuestionInput,
    parseQuestionOutput,
    restoreQuestionDraft,
    updateQuestionSelection
} from './model';
import type { QuestionAnswerValues, QuestionFormValues } from './model';
import useStyles from './styles';

export interface AskQuestionCardProps {
    conversationId: string;
    messageId: string;
    toolCallId: string;
    state: string;
    input?: unknown;
    output?: unknown;
    canAnswer: boolean;
    onAnswer?: (toolCallId: string, output: AskUserQuestionOutput) => Promise<void>;
}

interface AnswerControlProps {
    question: AskUserQuestion;
    value?: QuestionAnswerValues;
    onChange?: (value: QuestionAnswerValues) => void;
    disabled: boolean;
}

/** 选项只负责选择；Markdown 预览单独渲染，复制代码和点击链接不会误选。 */
function AnswerControl({ question, value, onChange, disabled }: AnswerControlProps) {
    const answer = value ?? { selectedOptionIndexes: [], otherSelected: false, customText: '' };
    const [previewTarget, setPreviewTarget] = useState<number | 'other'>(answer.selectedOptionIndexes[0] ?? 0);
    const hasPreview = !question.multiSelect && question.options.some((option) => option.preview !== undefined);
    const preview = typeof previewTarget === 'number' ? question.options[previewTarget]?.preview : undefined;
    const select = (choice: number | 'other', checked = true) => {
        if (disabled) return;
        onChange?.(updateQuestionSelection(question, answer, choice, checked));
    };
    const optionContent = (label: string, description: string) => (
        <span className="ask-question-card-option-content">
            <span className="ask-question-card-option-label">{label}</span>
            <span className="ask-question-card-option-description">{description}</span>
        </span>
    );
    const otherContent = optionContent('其他', '填写自定义答案');

    return (
        <div className={hasPreview ? 'ask-question-card-choice-layout' : undefined}>
            <div className="ask-question-card-controls">
                {question.multiSelect ? (
                    <div className="ask-question-card-options" role="group" aria-label={question.question}>
                        {question.options.map((option, index) => (
                            <Checkbox
                                key={index}
                                className="ask-question-card-option"
                                checked={answer.selectedOptionIndexes.includes(index)}
                                disabled={disabled}
                                onChange={(event) => select(index, event.target.checked)}
                            >
                                {optionContent(option.label, option.description)}
                            </Checkbox>
                        ))}
                        <Checkbox
                            className="ask-question-card-option"
                            checked={answer.otherSelected}
                            disabled={disabled}
                            onChange={(event) => select('other', event.target.checked)}
                        >
                            {otherContent}
                        </Checkbox>
                    </div>
                ) : (
                    <Radio.Group
                        className="ask-question-card-options"
                        aria-label={question.question}
                        value={answer.otherSelected ? 'other' : answer.selectedOptionIndexes[0]}
                        disabled={disabled}
                        onChange={(event) => {
                            const choice = event.target.value as number | 'other';
                            select(choice);
                            setPreviewTarget(choice);
                        }}
                    >
                        {question.options.map((option, index) => (
                            <Radio
                                key={index}
                                value={index}
                                className="ask-question-card-option"
                                onMouseEnter={() => setPreviewTarget(index)}
                                onFocus={() => setPreviewTarget(index)}
                            >
                                {optionContent(option.label, option.description)}
                            </Radio>
                        ))}
                        <Radio
                            value="other"
                            className="ask-question-card-option"
                            onMouseEnter={() => setPreviewTarget('other')}
                            onFocus={() => setPreviewTarget('other')}
                        >
                            {otherContent}
                        </Radio>
                    </Radio.Group>
                )}
                {answer.otherSelected && (
                    <Input.TextArea
                        className="ask-question-card-custom-input"
                        aria-label={`${question.header}：其他答案`}
                        placeholder="请输入你的答案"
                        value={answer.customText}
                        disabled={disabled}
                        autoSize={{ minRows: 2, maxRows: 6 }}
                        onChange={(event) => onChange?.({ ...answer, customText: event.target.value })}
                    />
                )}
            </div>
            {hasPreview && (
                <aside className="ask-question-card-preview" aria-label="选项预览">
                    <div className="ask-question-card-preview-title">
                        {typeof previewTarget === 'number' ? question.options[previewTarget].label : '其他'} · 预览
                    </div>
                    {preview ? (
                        <StreamingMarkdown text={preview} streaming={false} />
                    ) : (
                        <div className="ask-question-card-hint">此选项暂无预览</div>
                    )}
                </aside>
            )}
        </div>
    );
}

function AnswerSummary({ input, output }: { input: AskUserQuestionInput; output: AskUserQuestionOutput }) {
    return (
        <div className="ask-question-card-summary">
            <div className="ask-question-card-selected">
                <CheckCircleFilled />
                <span>已回答</span>
            </div>
            {output.answers.map((answer) => (
                <section className="ask-question-card-summary-question" key={answer.questionIndex}>
                    <div className="ask-question-card-hint">
                        {answer.questionIndex + 1}. {input.questions[answer.questionIndex].header}
                    </div>
                    <div className="ask-question-card-question">{answer.question}</div>
                    {answer.selectedOptions.length > 0 && (
                        <ul className="ask-question-card-summary-options">
                            {answer.selectedOptions.map((label) => (
                                <li key={label}>{label}</li>
                            ))}
                        </ul>
                    )}
                    {answer.customText !== undefined && (
                        <div className="ask-question-card-custom-summary">
                            <span className="ask-question-card-hint">自定义回答</span>
                            <div>{answer.customText}</div>
                        </div>
                    )}
                </section>
            ))}
        </div>
    );
}

interface QuestionFormProps {
    conversationId: string;
    draftKey: string;
    input: AskUserQuestionInput;
    disabled: boolean;
    saving: boolean;
    onSubmit: (output: AskUserQuestionOutput) => Promise<void>;
}

function QuestionForm({ conversationId, draftKey, input, disabled, saving, onSubmit }: QuestionFormProps) {
    const [form] = Form.useForm<QuestionFormValues>();
    // 按完整调用身份挂载一次；token 更新、切题和 store 草稿写入均不能重置 Form。
    const [initialDraft] = useState(() =>
        restoreQuestionDraft(input, useChatStore.getState().questionDraftsByConversation[conversationId]?.[draftKey])
    );
    const [currentQuestion, setCurrentQuestion] = useState(initialDraft.currentQuestion);
    const setQuestionDraft = useChatStore((store) => store.setQuestionDraft);
    const clearQuestionDraft = useChatStore((store) => store.clearQuestionDraft);
    const watchedAnswers = Form.useWatch('answers', form) as QuestionAnswerValues[] | undefined;
    const values = { answers: watchedAnswers ?? initialDraft.values.answers };
    const validOutput = buildQuestionOutput(input, values);
    const completed = input.questions.filter(
        (question, index) => !getAnswerError(question, values.answers[index])
    ).length;

    useEffect(() => {
        const previous = useChatStore.getState().questionDraftsByConversation[conversationId]?.[draftKey];
        if (previous && previous.inputFingerprint !== initialDraft.inputFingerprint) {
            clearQuestionDraft(conversationId, draftKey);
        }
    }, [conversationId, draftKey, initialDraft.inputFingerprint, clearQuestionDraft]);

    const remember = (nextValues: QuestionFormValues, nextQuestion = currentQuestion) => {
        setQuestionDraft(conversationId, draftKey, {
            inputFingerprint: initialDraft.inputFingerprint,
            currentQuestion: nextQuestion,
            values: nextValues
        });
    };
    const navigate = (index: number) => {
        setCurrentQuestion(index);
        remember(form.getFieldsValue(true), index);
    };
    const submit = async () => {
        if (disabled || saving) return;
        try {
            const allValues = await form.validateFields();
            const output = buildQuestionOutput(input, allValues);
            if (output) await onSubmit(output);
        } catch {
            // 所有题字段保持挂载，才能全组校验并定位首个无效题，而不是只校验当前页。
            const allValues = form.getFieldsValue(true);
            const firstInvalid = input.questions.findIndex((question, index) =>
                getAnswerError(question, allValues.answers?.[index])
            );
            if (firstInvalid >= 0) navigate(firstInvalid);
        }
    };

    return (
        <Form
            form={form}
            initialValues={initialDraft.values}
            layout="vertical"
            preserve
            disabled={disabled || saving}
            onValuesChange={(_, allValues: QuestionFormValues) => remember(allValues)}
            onFinish={() => void submit()}
            onFinishFailed={({ errorFields }) => {
                const firstQuestion = errorFields[0]?.name[1];
                if (typeof firstQuestion === 'number') navigate(firstQuestion);
            }}
        >
            <nav className="ask-question-card-navigation" aria-label="问题导航">
                {input.questions.map((question, index) => (
                    <Button
                        key={index}
                        size="small"
                        type={currentQuestion === index ? 'primary' : 'default'}
                        aria-current={currentQuestion === index ? 'step' : undefined}
                        aria-label={`第 ${index + 1} 题：${question.header}${getAnswerError(question, values.answers[index]) ? '，未完成' : '，已完成'}`}
                        disabled={saving}
                        onClick={() => navigate(index)}
                    >
                        {!getAnswerError(question, values.answers[index]) && <CheckCircleFilled />}
                        {index + 1}. {question.header}
                    </Button>
                ))}
            </nav>
            {input.questions.map((question, index) => (
                <section key={index} hidden={currentQuestion !== index}>
                    <div className="ask-question-card-question">{question.question}</div>
                    <div className="ask-question-card-hint ask-question-card-mode">
                        {question.multiSelect ? '可多选，也可同时填写其他答案' : '请选择一项，或填写其他答案'}
                    </div>
                    <Form.Item
                        name={['answers', index]}
                        rules={[
                            {
                                validator: (_, answer: unknown) => {
                                    const error = getAnswerError(question, answer);
                                    return error ? Promise.reject(new Error(error)) : Promise.resolve();
                                }
                            }
                        ]}
                    >
                        <AnswerControl question={question} disabled={disabled || saving} />
                    </Form.Item>
                </section>
            ))}
            <div className="ask-question-card-footer">
                <span className="ask-question-card-hint" aria-live="polite">
                    已完成 {completed}/{input.questions.length} 题
                </span>
                <div className="ask-question-card-actions">
                    {currentQuestion > 0 && (
                        <Button disabled={saving} onClick={() => navigate(currentQuestion - 1)}>
                            上一题
                        </Button>
                    )}
                    {currentQuestion < input.questions.length - 1 && (
                        <Button disabled={saving} onClick={() => navigate(currentQuestion + 1)}>
                            下一题
                        </Button>
                    )}
                    {!disabled && (
                        <Button type="primary" htmlType="submit" loading={saving} disabled={!validOutput || saving}>
                            提交全部回答
                        </Button>
                    )}
                </div>
            </div>
        </Form>
    );
}

export const AskQuestionCard = memo(function AskQuestionCard({
    conversationId,
    messageId,
    toolCallId,
    state,
    input,
    output,
    canAnswer,
    onAnswer
}: AskQuestionCardProps) {
    const { styles, cx } = useStyles();
    const parsedInput = useMemo(() => parseQuestionInput(input), [input]);
    const draftKey = JSON.stringify([messageId, toolCallId]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const localLock = useRef(false);
    const parsedOutput = parsedInput ? parseQuestionOutput(parsedInput, output) : null;

    const submit = async (answer: AskUserQuestionOutput) => {
        if (state !== 'input-available' || !canAnswer || !onAnswer || localLock.current) return;
        // React 状态更新前也可能连续触发提交，先用本地同步锁挡住重复调用。
        localLock.current = true;
        setSaving(true);
        setError(null);
        try {
            // 仅等待父方回填 SDK 工具结果，不代表回答已落盘。
            await onAnswer(toolCallId, answer);
            useChatStore.getState().clearQuestionDraft(conversationId, draftKey);
        } catch {
            setError('提交失败，当前会话中的回答草稿已保留，可修改后再次提交。');
        } finally {
            localLock.current = false;
            setSaving(false);
        }
    };

    let content;
    if (state === 'output-available') {
        content =
            parsedInput && parsedOutput ? (
                <AnswerSummary input={parsedInput} output={parsedOutput} />
            ) : (
                <div className="ask-question-card-hint" role="status">
                    回答数据无效，无法展示摘要
                </div>
            );
    } else if (state === 'input-streaming') {
        content = (
            <div className="ask-question-card-hint" role="status">
                问题准备中…
            </div>
        );
    } else if (!parsedInput) {
        content = (
            <div className="ask-question-card-hint" role="status">
                问题格式无效，无法作答
            </div>
        );
    } else {
        const editable = state === 'input-available' && canAnswer && !!onAnswer;
        content = (
            <>
                {error && <Alert type="warning" showIcon title={error} />}
                {!editable && (
                    <div className="ask-question-card-hint" role="status">
                        {state === 'output-error' || state === 'output-denied'
                            ? '问题执行失败或已被拒绝，无法继续作答'
                            : '该问题已结束或当前暂不可作答'}
                    </div>
                )}
                <QuestionForm
                    key={JSON.stringify([conversationId, messageId, toolCallId, getInputFingerprint(parsedInput)])}
                    conversationId={conversationId}
                    draftKey={draftKey}
                    input={parsedInput}
                    disabled={!editable}
                    saving={saving}
                    onSubmit={submit}
                />
            </>
        );
    }

    return (
        <div
            className={cx('ask-question-card', styles.toString())}
            data-question-anchor={toolCallId}
            aria-busy={saving}
        >
            <div className="ask-question-card-header">
                <QuestionCircleOutlined />
                <span>补充信息{parsedInput ? ` · ${parsedInput.questions.length} 题` : ''}</span>
            </div>
            {content}
        </div>
    );
});
