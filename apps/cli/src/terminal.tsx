import { randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { Chat, useChat } from '@ai-sdk/react';
import type { CommandExpandResult, CommandSummary, PermissionData } from '@zhuixun/shared';
import {
    DefaultChatTransport,
    getToolName,
    isToolUIPart,
    lastAssistantMessageIsCompleteWithApprovalResponses,
    lastAssistantMessageIsCompleteWithToolCalls
} from 'ai';
import type { UIMessage } from 'ai';
import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';

import { bindTelegram, channelCommand } from './channels';
import type { Api } from './client';
import { choicesFor, commands, indexFiles } from './completion';
import type { Choice } from './completion';
import { setLocale as setTranslationLocale } from './i18n';
import { loadPreferences, savePreferences, themes, locales } from './preferences';
import type { Preferences } from './preferences';
import { CommandPalette } from './ui/chat/CommandPalette';
import { groupParts } from './ui/messages/groupToolParts';
import { ReasoningPart } from './ui/messages/ReasoningPart';
import { TextPart } from './ui/messages/TextPart';
import { ToolCallGroup } from './ui/messages/ToolCallGroup';
import { ToolCallPart } from './ui/messages/ToolCallPart';
import { UserMessage } from './ui/messages/UserMessage';
import { Header } from './ui/status/Header';
import { Divider } from './ui/text/Divider';
import { ListItem } from './ui/text/ListItem';
import { ThemeProvider } from './ui/text/theme';
import { ThemedBox } from './ui/text/ThemedBox';
import { ThemedText } from './ui/text/ThemedText';
import { updateCli } from './update';
import { isTerminalToolState } from './utils/tool-state';

interface Conversation {
    id: string;
    title: string;
    projectId?: string;
    origin?: { kind: 'channel' };
    roots?: Project['roots'];
    messages: (Omit<UIMessage, 'parts'> & { parts?: UIMessage['parts']; content?: string })[];
}

interface Project {
    id: string;
    name: string;
    roots?: { path: string; primary: boolean }[];
}

interface Question {
    question: string;
    options: { label: string; description: string; preview?: string }[];
    multiSelect?: boolean;
}

const help =
    '输入 / 联想命令，输入 @ 选择附件。↑/↓ 导航，Tab 补全，Enter 确认，Esc 取消，Ctrl+O 切换工具详情，Ctrl+R 切换推理。';

export class TerminalSession {
    readonly chat: Chat<UIMessage>;
    requestId?: string;
    replaying = false;
    model?: string;
    readonly channelSession: boolean;

    constructor(
        readonly api: Api,
        readonly projectId?: string,
        readonly agentMode?: string,
        history?: Conversation,
        readonly workdir = process.cwd()
    ) {
        this.channelSession = history?.origin?.kind === 'channel';
        this.chat = new Chat<UIMessage>({
            id: history?.id ?? randomUUID(),
            generateId: randomUUID,
            messages:
                history?.messages.map(({ id, role, parts, content, metadata }) => ({
                    id,
                    role,
                    metadata,
                    parts: parts ?? (content ? [{ type: 'text', text: content }] : [])
                })) ?? [],
            transport: new DefaultChatTransport({
                api: api.origin + '/api/chat/stream',
                headers: api.headers,
                fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
                body: () => {
                    this.requestId = randomUUID();
                    return {
                        sessionId: this.chat.id,
                        requestId: this.requestId,
                        projectId: this.projectId,
                        model: this.model,
                        agentMode: this.agentMode
                    };
                }
            }),
            sendAutomaticallyWhen: (state) =>
                !this.replaying &&
                (lastAssistantMessageIsCompleteWithApprovalResponses(state) ||
                    lastAssistantMessageIsCompleteWithToolCalls(state))
        });
    }

    async cancel(): Promise<void> {
        const id = this.requestId;
        try {
            if (id) {
                await this.api.post(`/api/chat/${this.chat.id}/cancel?requestId=${id}`);
            }
        } finally {
            await this.chat.stop();
        }
    }
}

export async function createSession(api: Api, projectId?: string, history?: Conversation): Promise<TerminalSession> {
    const settings = await api.request<{ defaultAgentMode?: string }>('/api/settings/app');
    const projects = history ? [] : await api.request<Project[]>('/api/projects');
    const cwd = path.resolve(process.cwd());
    const matches = projects.filter((project) =>
        project.roots?.some((root) => root.primary && path.resolve(root.path) === cwd)
    );
    const project = projectId
        ? projects.find((item) => item.id === projectId)
        : matches.length === 1
          ? matches[0]
          : undefined;
    return new TerminalSession(
        api,
        history ? history.projectId : project?.id,
        settings.defaultAgentMode,
        history,
        (history?.roots ?? project?.roots)?.find((root) => root.primary)?.path ?? cwd
    );
}

export function Terminal({ session: initial, version }: { session: TerminalSession; version: string }) {
    const [session, setSession] = useState(initial);
    const [preferences, setPreferences] = useState<Preferences>({ theme: 'mayday', locale: 'zh' });
    useEffect(() => {
        void loadPreferences().then((value) => {
            setTranslationLocale(value.locale);
            setPreferences(value);
        });
    }, []);
    async function setPreference(patch: Partial<Preferences>) {
        const next = { ...preferences, ...patch };
        await savePreferences(next);
        setTranslationLocale(next.locale);
        setPreferences(next);
    }
    return (
        <ThemeProvider themeName={preferences.theme}>
            <SessionView
                key={session.chat.id}
                session={session}
                version={version}
                switchSession={setSession}
                setTheme={(theme) => setPreference({ theme })}
                locale={preferences.locale}
                setLocale={(locale) => setPreference({ locale })}
            />
        </ThemeProvider>
    );
}

function SessionView({
    session,
    switchSession,
    version,
    setTheme,
    locale,
    setLocale
}: {
    session: TerminalSession;
    version: string;
    switchSession(next: TerminalSession): void;
    setTheme(value: Preferences['theme']): Promise<void>;
    locale: Preferences['locale'];
    setLocale(value: Preferences['locale']): Promise<void>;
}) {
    const { api } = session;
    const { exit } = useApp();
    const chat = useChat({ chat: session.chat, throttle: 35 });
    const [input, setInput] = useState('');
    const inputValue = useRef('');
    const [selection, setSelection] = useState(0);
    const [custom, setCustom] = useState<Choice[]>([]);
    const [files, setFiles] = useState<string[]>([]);
    const [attachments, setAttachments] = useState<string[]>([]);
    const [picker, setPicker] = useState<{ choices: Choice[]; choose(value: string): Promise<void> }>();
    const [hidden, setHidden] = useState(false);
    const submitting = useRef(false);
    const changeInput = (value: string) => {
        inputValue.current = value;
        setInput(value);
        setSelection(0);
        setHidden(false);
    };
    const [notice, setNotice] = useState(help);
    const [secret, setSecret] = useState<'telegram' | 'provider'>();
    const [provider, setProvider] = useState<{ name: string; kind: string; baseURL: string; models: string[] }>();
    const [showTools, setShowTools] = useState(false);
    const [showReasoning, setShowReasoning] = useState(false);
    const [history, setHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(0);
    const [action, setAction] = useState<AbortController>();
    const [answers, setAnswers] = useState<
        { questionIndex: number; question: string; selectedOptions: string[]; customText?: string }[]
    >([]);
    const busy = chat.status === 'streaming' || chat.status === 'submitted';
    const tools =
        chat.messages.at(-1)?.role === 'assistant' ? (chat.messages.at(-1)?.parts.filter(isToolUIPart) ?? []) : [];
    const approval = tools.find((part) => part.state === 'approval-requested');
    const question = tools.find((part) => getToolName(part) === 'askUserQuestion' && part.state === 'input-available');
    const [approvalSelection, setApprovalSelection] = useState(0);
    const approvalOptions =
        approval && ['Bash', 'Write', 'Edit'].includes(getToolName(approval))
            ? [
                  ['y', '批准执行'],
                  ['s', '本次会话内记住'],
                  ['p', '永久记住'],
                  ['n', '拒绝']
              ]
            : [
                  ['y', '批准执行'],
                  ['n', '拒绝']
              ];
    const approvalMenu = approval && !busy && !action && !secret && !input && !picker;
    useEffect(() => setApprovalSelection(0), [approval?.toolCallId]);
    const currentQuestion = (question?.input as { questions?: Question[] } | undefined)?.questions?.[answers.length];

    useEffect(() => {
        const controller = new AbortController();
        void api
            .request<{ ids: string[] }>('/api/chat/active', { signal: controller.signal })
            .then(({ ids }) => {
                if (!controller.signal.aborted && ids.includes(session.chat.id)) {
                    session.replaying = true;
                    return session.chat.resumeStream().finally(() => {
                        session.replaying = false;
                    });
                }
            })
            .catch(() => undefined);
        return () => {
            controller.abort();
            void session.chat.stop();
        };
    }, [api, session]);

    async function refreshCommands(signal?: AbortSignal) {
        const data = await api.request<{ user: CommandSummary[] }>('/api/commands', { signal });
        if (!signal?.aborted)
            setCustom(
                data.user.map((item) => ({
                    label: '/' + item.name,
                    value: '/' + item.name,
                    description: [item.description, item.argumentHint].filter(Boolean).join(' '),
                    requiresArguments: !!item.argumentHint
                }))
            );
    }

    useEffect(() => {
        const controller = new AbortController();
        void refreshCommands(controller.signal).catch(() => undefined);
        void indexFiles(session.workdir).then((result) => {
            if (!controller.signal.aborted) setFiles(result);
        });
        return () => controller.abort();
        // 会话切换会重挂载终端输入，索引随工作目录更新。
    }, [api, session.workdir]);

    const suggestions = secret || hidden ? undefined : (picker?.choices ?? choicesFor(input, custom, files));
    const selected = suggestions?.[selection];

    function pick(choices: Choice[], choose: (value: string) => Promise<void>) {
        if (!choices.length) return;
        setSelection(0);
        setHidden(false);
        setPicker({ choices, choose });
    }

    async function send(text: string) {
        if (session.channelSession) throw new Error('渠道会话仅供查看，请使用 /new 开始本地对话');
        const parts: UIMessage['parts'] = [{ type: 'text', text }];
        if (text.startsWith('/')) {
            const result = await api.post<CommandExpandResult>('/api/commands/expand', { text });
            if (result.matched && result.name && result.expanded !== undefined) {
                parts.push({
                    type: 'data-command',
                    data: { name: result.name, args: result.args ?? '', expanded: result.expanded }
                });
            }
        }
        const root = attachments.length ? await realpath(session.workdir) : session.workdir;
        for (const file of attachments) {
            const target = await realpath(path.join(root, file));
            const relative = path.relative(root, target);
            if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
                throw new Error('附件必须位于当前工作目录内');
            }
            const handle = await open(target, 'r');
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('附件必须是 20 MB 以内的文件');
                const form = new FormData();
                form.set('sessionId', chat.id);
                form.set('file', new Blob([await handle.readFile()]), path.basename(file));
                const uploaded = await api.request<{ url: string; filename: string; mediaType: string }>(
                    '/api/chat/upload',
                    { method: 'POST', body: form }
                );
                parts.push({
                    type: 'file',
                    url: api.origin + uploaded.url,
                    filename: uploaded.filename,
                    mediaType: uploaded.mediaType
                });
            } finally {
                await handle.close();
            }
        }
        await chat.sendMessage({ parts });
        if (!session.chat.error) setAttachments([]);
    }

    async function command(text: string): Promise<void> {
        const [name, arg, target] = text.split(/\s+/);
        const rest = text.slice(name.length).trim();
        switch (name) {
            case '/exit':
                exit();
                return;
            case '/help':
                setNotice(
                    Object.entries(commands)
                        .map(([name, desc]) => '/' + name + '  ' + desc)
                        .join('\n')
                );
                return;
            case '/status':
                setNotice(
                    `会话 ${chat.id}\n项目 ${session.projectId ?? '默认工作区'}\n模型 ${session.model ?? '后端默认'}`
                );
                return;
            case '/sessions': {
                const list = await api.request<Conversation[]>('/api/conversations');
                setNotice(list.length ? '选择要打开的会话' : '暂无会话');
                pick(
                    list.map((item) => ({ label: item.title, value: item.id })),
                    async (id) => command('/resume ' + id)
                );
                return;
            }
            case '/resume': {
                if (!arg) throw new Error('用法：/resume <会话 ID>');
                const saved = await api.request<Conversation>(`/api/conversations/${encodeURIComponent(arg)}`);
                switchSession(await createSession(api, undefined, saved));
                return;
            }
            case '/new':
            case '/clear':
                switchSession(await createSession(api, session.projectId));
                return;
            case '/project': {
                const projects = await api.request<Project[]>('/api/projects');
                if (!arg) {
                    setNotice(projects.length ? '选择项目' : '暂无项目');
                    pick(
                        projects.map((item) => ({ label: item.name, value: item.id })),
                        async (id) => command('/project ' + id)
                    );
                    return;
                }
                if (!projects.some((p) => p.id === arg)) throw new Error('找不到该项目');
                switchSession(await createSession(api, arg));
                return;
            }
            case '/config': {
                if (!rest) {
                    const result = await api.request<{
                        providers: { name: string; kind: string; models: string[]; configured: boolean }[];
                    }>('/api/settings/model');
                    setNotice(
                        [
                            ...result.providers.map(
                                (item) => item.name + ' (' + item.kind + ') · ' + item.models.join(', ')
                            ),
                            '/config <名称> <类型> <baseURL> <模型> 添加或更新供应商；/model 选择模型'
                        ].join('\n')
                    );
                    return;
                }
                const [providerName, kind, baseURL, model] = rest.split(/\s+/);
                if (
                    !providerName ||
                    !kind ||
                    !baseURL ||
                    !model ||
                    !['openai', 'anthropic', 'google', 'openai-compatible'].includes(kind)
                ) {
                    throw new Error(
                        '用法：/config <名称> <openai|anthropic|google|openai-compatible> <baseURL> <模型>'
                    );
                }
                if (rest.split(/\s+/).length !== 4) throw new Error('请在提示后输入 API Key');
                setProvider({ name: providerName, kind, baseURL, models: [model] });
                setSecret('provider');
                setNotice('请输入模型 API Key');
                return;
            }
            case '/model': {
                const settings = await api.request<{
                    providers: { name: string; models: string[] }[];
                    activeModel?: string;
                }>('/api/settings/model');
                const models = settings.providers.flatMap((p) => p.models.map((model) => `${p.name}/${model}`));
                if (arg && !models.includes(arg)) throw new Error('找不到该模型');
                if (arg) session.model = arg;
                else
                    pick(
                        models.map((model) => ({ label: model, value: model })),
                        async (model) => command('/model ' + model)
                    );
                setNotice(arg ? `当前会话模型：${arg}` : models.join('\n') || '请先在 追寻 设置中配置模型');
                return;
            }
            case '/compact':
                await api.post(`/api/conversations/${chat.id}/compact`, { instructions: rest });
                setNotice('会话已压缩');
                return;
            case '/channel':
                if (arg === 'login' && target === 'telegram') {
                    if (text.split(/\s+/).length !== 3)
                        throw new Error('请使用 /channel login telegram 并在提示后输入 Token');
                    setSecret('telegram');
                    setNotice('请输入 Telegram Bot Token');
                    return;
                }
                {
                    const controller = new AbortController();
                    setAction(controller);
                    try {
                        setNotice(await channelCommand(api, arg, target, controller.signal));
                    } finally {
                        setAction(undefined);
                    }
                }
                return;
            case '/cancel':
                await session.cancel();
                return;
            case '/reload':
                await refreshCommands();
                setFiles(await indexFiles(session.workdir));
                setNotice('已刷新文件和命令索引');
                return;
            case '/tools': {
                const labels = await api.request<Record<string, { label: string }>>('/api/tools/labels');
                setNotice(
                    [
                        ...Object.entries(labels).map(([tool, info]) => tool + ': ' + info.label),
                        '工具可用性由后端模式、已加载技能和权限决定'
                    ].join('\n')
                );
                return;
            }
            case '/approvals': {
                if (arg === 'on' || arg === 'off') {
                    await api.request('/api/permissions/auto-approval', {
                        method: 'PUT',
                        body: JSON.stringify({ enabled: arg === 'on' })
                    });
                }
                if (arg === 'delete' && target) {
                    await api.request('/api/permissions/' + encodeURIComponent(target), { method: 'DELETE' });
                }
                const data = await api.request<PermissionData>('/api/permissions');
                setNotice(
                    [
                        '自动放行：' + (data.autoApprovalEnabled ? '开启' : '关闭'),
                        ...data.bash.allow.map((rule) => 'Bash ' + rule.head + ' · ' + rule.id),
                        ...data.write.allow.map((rule) => 'Write ' + rule.dir + ' · ' + rule.id),
                        ...Object.entries(data.rules).flatMap(([kind, rules]) =>
                            rules.map((rule: string) => kind + ' ' + rule)
                        ),
                        '启停自动放行：/approvals on|off，删除规则：/approvals delete <id>'
                    ].join('\n')
                );
                return;
            }
            case '/theme': {
                const color = themes.find((item) => item === arg);
                if (arg && !color) throw new Error('未知配色');
                if (color) await setTheme(color);
                else
                    pick(
                        themes.map((value) => ({ label: value, value })),
                        async (value) => command('/theme ' + value)
                    );
                setNotice(color ? '已切换配色' : '选择配色');
                return;
            }
            case '/locale': {
                const language = locales.find((item) => item === arg);
                if (arg && !language) throw new Error('支持 zh、en');
                if (language) await setLocale(language);
                else
                    pick(
                        locales.map((value) => ({ label: value, value })),
                        async (value) => command('/locale ' + value)
                    );
                setNotice('Language: ' + (language ?? locale));
                return;
            }
            case '/update':
                setNotice(await updateCli(version, arg === 'install'));
                return;
            case '/agents':
                setNotice('新版后端通过 Task 执行子任务。直接在对话中描述要委派的任务。');
                return;
            default:
                setNotice('');
                await send(text);
        }
    }

    async function submit(): Promise<void> {
        if (submitting.current) return;
        submitting.current = true;
        try {
            await submitInput();
        } finally {
            submitting.current = false;
        }
    }

    async function submitInput(): Promise<void> {
        const text = inputValue.current.trim();
        if (!text && !attachments.length) return;
        changeInput('');
        if (secret) {
            setSecret(undefined);
            if (secret === 'telegram') setNotice(await bindTelegram(api, text));
            else if (provider) {
                setProvider(undefined);
                const { providers } = await api.request<{ providers: { name: string; models: string[] }[] }>(
                    '/api/settings/model'
                );
                const existing = providers.find((item) => item.name === provider.name);
                const body = {
                    ...provider,
                    models: [...new Set([...(existing?.models ?? []), ...provider.models])],
                    apiKey: text
                };
                if (existing)
                    await api.request('/api/settings/providers/' + encodeURIComponent(provider.name), {
                        method: 'PUT',
                        body: JSON.stringify(body)
                    });
                else await api.post('/api/settings/providers', body);
                await api.request('/api/settings/model/active', {
                    method: 'PUT',
                    body: JSON.stringify({ activeModel: `${provider.name}/${provider.models[0]}` })
                });
                setNotice('模型已保存并激活');
            }
        } else if (approval?.state === 'approval-requested' && !text.startsWith('/')) {
            const decision = text.toLowerCase();
            if (!['y', 'n', 's', 'p'].includes(decision))
                throw new Error('输入 y 批准，n 拒绝，s 本会话记住，p 永久记住');
            const tool = getToolName(approval);
            const input = approval.input as { command?: string; path?: string; file_path?: string };
            if (decision === 's' || decision === 'p') {
                const target = tool === 'Bash' ? input.command : (input.path ?? input.file_path);
                if (!target || !['Bash', 'Write', 'Edit'].includes(tool)) throw new Error('该工具仅支持单次确认');
                try {
                    const saved = await api.post<{ rule: unknown }>('/api/permissions', {
                        tool: tool === 'Bash' ? 'Bash' : 'Write',
                        ...(tool === 'Bash' ? { command: target } : { filePath: target }),
                        scope: decision === 's' ? 'session' : 'permanent',
                        sessionId: chat.id
                    });
                    setNotice(saved.rule ? '已记住审批规则' : '后端未保存规则，本次仍批准');
                } catch {
                    setNotice('保存规则失败，本次仍批准');
                }
            }
            await chat.addToolApprovalResponse({ id: approval.approval.id, approved: decision !== 'n' });
        } else if (currentQuestion && question && !text.startsWith('/')) {
            const customText = text.startsWith('=') ? text.slice(1).trim() : undefined;
            const indices = text.split(',').map((value) => Number(value.trim()) - 1);
            const selected = customText
                ? []
                : [...new Set(indices)].map((index) => currentQuestion.options[index]?.label);
            if (selected.some((item) => !item) || (!currentQuestion.multiSelect && selected.length > 1)) {
                throw new Error('请输入有效选项编号，或用 = 开头输入自定义回答');
            }
            const next = [
                ...answers,
                {
                    questionIndex: answers.length,
                    question: currentQuestion.question,
                    selectedOptions: selected,
                    ...(customText ? { customText } : {})
                }
            ];
            if (next.length === (question.input as { questions: Question[] }).questions.length) {
                await chat.addToolOutput({
                    tool: 'askUserQuestion',
                    toolCallId: question.toolCallId,
                    output: { answers: next }
                });
                setAnswers([]);
            } else setAnswers(next);
        } else {
            if (!/^\/(?:channel\s+login|config)\b/.test(text)) {
                setHistory([...history, text]);
                setHistoryIndex(history.length + 1);
            }
            if ((approval || question) && !text.startsWith('/')) throw new Error('请先处理等待中的工具交互');
            await command(text);
        }
    }

    function report(error: unknown) {
        setNotice(error instanceof Error ? error.message : String(error));
    }

    useInput((keyInput, key) => {
        if (key.ctrl && keyInput === 'r') {
            setShowReasoning(!showReasoning);
        } else if (key.ctrl && keyInput === 'o') {
            setShowTools(!showTools);
        } else if (key.escape || (key.ctrl && keyInput === 'c')) {
            if (action) action.abort();
            else if (busy) void session.cancel().catch(report);
            else if (picker) setPicker(undefined);
            else if (suggestions) setHidden(true);
            else if (secret) {
                setSecret(undefined);
                changeInput('');
                setNotice('已取消绑定');
            } else if (key.ctrl) exit();
        } else if (!busy && !action) {
            if (approvalMenu && (key.upArrow || key.downArrow)) {
                setApprovalSelection(
                    (index) => (index + (key.upArrow ? -1 : 1) + approvalOptions.length) % approvalOptions.length
                );
            } else if (approvalMenu && key.return) {
                const option = approvalOptions[approvalSelection];
                if (option) {
                    changeInput(option[0]);
                    void submit().catch(report);
                }
            } else if ((key.upArrow || key.downArrow) && suggestions?.length) {
                setSelection((index) => (index + (key.upArrow ? -1 : 1) + suggestions.length) % suggestions.length);
            } else if (
                (key.tab || key.return) &&
                selected &&
                (picker || !input.startsWith('/') || key.tab || input !== selected.value)
            ) {
                if (picker) {
                    setPicker(undefined);
                    void picker.choose(selected.value).catch(report);
                } else if (input.startsWith('/')) {
                    changeInput(selected.value + ' ');
                    if (key.return && !selected.requiresArguments) void submit().catch(report);
                } else {
                    setAttachments((items) => [...new Set([...items, selected.value])]);
                    changeInput(input.replace(/@[^\s]*$/, ''));
                }
            } else if (key.ctrl && keyInput === 'u') {
                setAttachments([]);
                changeInput('');
            } else if (picker) {
                return;
            } else if (key.return) void submit().catch(report);
            else if (key.backspace || key.delete) changeInput(Array.from(inputValue.current).slice(0, -1).join(''));
            else if (key.upArrow && !secret) {
                const index = Math.max(0, historyIndex - 1);
                setHistoryIndex(index);
                changeInput(history[index] ?? '');
            } else if (key.downArrow && !secret) {
                const index = Math.min(history.length, historyIndex + 1);
                setHistoryIndex(index);
                changeInput(history[index] ?? '');
            } else if (!key.ctrl && !key.meta && !key.tab && !key.leftArrow && !key.rightArrow) {
                const [line, ...remaining] = keyInput.split(/\r\n|\r|\n/);
                changeInput(
                    inputValue.current +
                        Array.from(line)
                            .filter((char) => char >= ' ' && char !== '\x7f')
                            .join('')
                );
                if (remaining.length) void submit().catch(report);
            }
        }
    });

    return (
        <Box flexDirection="column">
            <Header version={version} status={busy ? 'streaming' : 'idle'} pendingApproval={!!approval} />
            <Box flexDirection="column" paddingX={1}>
                {chat.messages.map((message, index) => (
                    <Box key={message.id} flexDirection="column">
                        {index > 0 && <Divider padding={2} />}
                        {message.role === 'user' ? (
                            <UserMessage
                                text={message.parts
                                    .map((part) =>
                                        part.type === 'text'
                                            ? part.text
                                            : part.type === 'file'
                                              ? '@' + part.filename
                                              : ''
                                    )
                                    .filter(Boolean)
                                    .join(' ')}
                            />
                        ) : (
                            groupParts(message.parts).map((group) => {
                                if (group.type === 'tool-group') {
                                    return (
                                        <ToolCallGroup
                                            key={group.startIndex}
                                            parts={group.parts}
                                            expanded={
                                                showTools ||
                                                !group.parts.every((part) => isTerminalToolState(part.state))
                                            }
                                        />
                                    );
                                }
                                const part = group.part;
                                if (part.type === 'text')
                                    return <TextPart key={group.startIndex} text={part.text} state={part.state} />;
                                if (part.type === 'reasoning')
                                    return (
                                        <ReasoningPart
                                            key={group.startIndex}
                                            text={part.text}
                                            state={part.state}
                                            showReasoning={showReasoning}
                                        />
                                    );
                                if (isToolUIPart(part)) return <ToolCallPart key={group.startIndex} part={part} />;
                                if (part.type === 'file')
                                    return (
                                        <Text key={group.startIndex} dimColor>
                                            @{part.filename}
                                        </Text>
                                    );
                                return null;
                            })
                        )}
                    </Box>
                ))}
            </Box>
            {notice && (
                <Text color="yellow">
                    {notice === help && locale === 'en'
                        ? 'Type / for commands or @ for files. ↑/↓ Navigate, Tab Complete, Enter Confirm, Esc Cancel.'
                        : notice}
                </Text>
            )}
            {chat.error && <Text color="red">{chat.error.message}</Text>}
            {!busy && approval && (
                <ThemedBox flexDirection="column" borderColor="warning" paddingX={1}>
                    <ThemedText bold color="warning">
                        {getToolName(approval)} · 等待审批
                    </ThemedText>
                    <ThemedText color="textDim">{JSON.stringify(approval.input)}</ThemedText>
                    {approvalMenu &&
                        approvalOptions.map(([value, label], index) => (
                            <ListItem key={value} isFocused={index === approvalSelection}>
                                {label}
                            </ListItem>
                        ))}
                    <ThemedText color="textDim">↑/↓ 选择 · Enter 确认 · y/n 单次确认</ThemedText>
                </ThemedBox>
            )}
            {!busy && !approval && currentQuestion && (
                <Text color="yellow">
                    {currentQuestion.question}
                    {'\n'}
                    {currentQuestion.options
                        .map(
                            (item, index) =>
                                `${index + 1}. ${item.label} · ${item.description}${item.preview ? `\n${item.preview}` : ''}`
                        )
                        .join('\n')}
                    {'\n'}
                    {currentQuestion.multiSelect ? '输入编号（逗号分隔）或 =自定义回答' : '输入编号或 =自定义回答'}
                </Text>
            )}
            {attachments.length > 0 && <Text dimColor>{attachments.map((item) => '@' + item).join('  ')}</Text>}
            <ThemedBox borderColor="border" paddingX={1}>
                <ThemedText color="accent">{'> '}</ThemedText>
                <ThemedText>
                    {busy
                        ? '生成中…（Esc 停止）'
                        : action
                          ? '正在绑定…（Esc 取消）'
                          : secret
                            ? '*'.repeat(input.length)
                            : input}
                </ThemedText>
            </ThemedBox>
            {!busy && !action && suggestions && (
                <>
                    <Divider color="border" />
                    <CommandPalette
                        commands={suggestions.slice(Math.max(0, selection - 7), Math.max(8, selection + 1))}
                        selectedIndex={Math.min(7, selection)}
                    />
                </>
            )}
        </Box>
    );
}
