import {
    AppstoreOutlined,
    BranchesOutlined,
    BulbOutlined,
    CodeOutlined,
    CompressOutlined,
    DashboardOutlined,
    DeleteOutlined,
    ExportOutlined,
    FileSearchOutlined,
    FontColorsOutlined,
    GlobalOutlined,
    ImportOutlined,
    KeyOutlined,
    LinkOutlined,
    MessageOutlined,
    ReloadOutlined,
    SafetyCertificateOutlined
} from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { App, Button, Menu, Radio, Space, Upload } from 'antd';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import PageHeader from '@/components/PageHeader';
import { SUCCESS_CODE } from '@/constant/code';
import { exportSettingsApi, fetchAppSettingsApi, importSettingsApi, updateAppSettingsApi } from '@/services';
import type { AgentMode, SettingsPayload } from '@/services';
import { useAppConfigStore, usePersonaStore, useSettingsStore } from '@/stores';
import { spacing } from '@/theme/tokens';

import { AgentGuardPanel } from './components/AgentGuardPanel';
import { AppUpdatePanel } from './components/AppUpdatePanel';
import { ChannelPanel } from './components/ChannelPanel';
import { CommandPanel } from './components/CommandPanel';
import { ContextCompactPanel } from './components/ContextCompactPanel';
import { EnvVarPanel } from './components/EnvVarPanel';
import { HooksPanel } from './components/HooksPanel';
import { LogPanel } from './components/LogPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { ModelProviderPanel } from './components/ModelProviderPanel';
import { PermissionPanel } from './components/PermissionPanel';
import { PersonaPanel } from './components/PersonaPanel';
import { RecycleBinPanel } from './components/RecycleBinPanel';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import { WebAccessPanel } from './components/WebAccessPanel';
import useStyles from './styles';

type SettingsTab =
    | 'model'
    | 'memory'
    | 'persona'
    | 'context'
    | 'guard'
    | 'hooks'
    | 'commands'
    | 'permission'
    | 'web'
    | 'channel'
    | 'env'
    | 'logs'
    | 'recycle'
    | 'app';

const settingsGroups = [
    {
        type: 'group' as const,
        label: '基础',
        children: [
            { key: 'model', icon: <LinkOutlined />, label: '模型配置' },
            { key: 'app', icon: <AppstoreOutlined />, label: '应用设置' }
        ]
    },
    {
        type: 'group' as const,
        label: '智能体',
        children: [
            { key: 'persona', icon: <FontColorsOutlined />, label: '智能体风格' },
            { key: 'memory', icon: <BulbOutlined />, label: '记忆管理' },
            { key: 'commands', icon: <CodeOutlined />, label: '命令' },
            { key: 'context', icon: <CompressOutlined />, label: '上下文压缩' },
            { key: 'guard', icon: <DashboardOutlined />, label: '运行护栏' }
        ]
    },
    {
        type: 'group' as const,
        label: '连接',
        children: [
            { key: 'web', icon: <GlobalOutlined />, label: 'Web 访问' },
            { key: 'channel', icon: <MessageOutlined />, label: '渠道接入' },
            { key: 'env', icon: <KeyOutlined />, label: '环境变量' }
        ]
    },
    {
        type: 'group' as const,
        label: '安全',
        children: [
            { key: 'permission', icon: <SafetyCertificateOutlined />, label: '命令授权' },
            { key: 'hooks', icon: <BranchesOutlined />, label: 'Hooks' }
        ]
    },
    {
        type: 'group' as const,
        label: '维护',
        children: [
            { key: 'logs', icon: <FileSearchOutlined />, label: '日志' },
            { key: 'recycle', icon: <DeleteOutlined />, label: '项目回收站' }
        ]
    }
];

export function SettingsPage() {
    const { styles, cx } = useStyles();
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const location = useLocation();
    // 支持外部深链跳转（如技能广场安装后引导到环境变量页）：navigate('/settings', { state: { tab: 'env' } })
    const initialTab = (location.state as { tab?: SettingsTab } | null)?.tab ?? 'model';
    const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

    // 应用级偏好：默认对话模式（真源在后端，store 为运行时镜像）
    const defaultAgentMode = useAppConfigStore((s) => s.defaultAgentMode);
    const setDefaultAgentMode = useAppConfigStore((s) => s.setDefaultAgentMode);
    const resetOnboarding = useSettingsStore((s) => s.resetOnboarding);

    // 恢复初始化配置：非破坏性——仅重新进入引导页，不清空已配模型
    const handleResetOnboarding = () => {
        modal.confirm({
            title: '恢复初始化配置',
            content: '将重新进入初始化引导页，可重新配置模型、对话模式与主题。已配置的模型不会被清空。',
            okText: '进入引导',
            cancelText: '取消',
            centered: true,
            onOk: () => {
                resetOnboarding();
                navigate('/onboarding');
            }
        });
    };

    const { loading: agentModeSaving, run: handleChangeAgentMode } = useRequest(
        async (mode: AgentMode) => {
            const res = await updateAppSettingsApi({ defaultAgentMode: mode });
            if (res.code === SUCCESS_CODE && res.data) {
                setDefaultAgentMode(res.data.defaultAgentMode);
                message.success('已更新默认对话模式');
            }
        },
        { manual: true }
    );

    const { loading: exporting, run: handleExportSettings } = useRequest(
        async () => {
            const res = await exportSettingsApi();
            if (res.code !== SUCCESS_CODE || !res.data) return;
            const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = '追寻-settings.json';
            a.click();
            URL.revokeObjectURL(url);
            message.success('配置已导出（不含 API Key 与环境变量值）');
        },
        { manual: true }
    );

    const { loading: importing, run: runImportSettings } = useRequest(
        async (payload: SettingsPayload) => {
            const res = await importSettingsApi(payload);
            if (res.code !== SUCCESS_CODE) return;
            message.success(res.data?.envNeedsRestart ? '配置已导入（env 段需重启后端才生效）' : '配置已导入');
            const appRes = await fetchAppSettingsApi();
            if (appRes.code === SUCCESS_CODE && appRes.data) setDefaultAgentMode(appRes.data.defaultAgentMode);
            void usePersonaStore.getState().refresh();
        },
        { manual: true }
    );

    // Upload 的 beforeUpload：读取文件为 JSON 后触发导入，返回 false 阻止 antd 自动上传
    const handleImportFile = (file: File) => {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                runImportSettings(JSON.parse(String(reader.result)) as SettingsPayload);
            } catch {
                message.error('文件不是合法的 JSON 配置');
            }
        };
        reader.readAsText(file);
        return false;
    };

    return (
        <div className={cx('settings-page', styles.toString())}>
            <PageHeader paddingBlock={spacing.md}>
                <span className="settings-page-title">设置</span>
            </PageHeader>
            <div className="settings-page-content">
                <Menu
                    className="settings-page-tab-nav"
                    mode="inline"
                    inlineIndent={12}
                    selectedKeys={[activeTab]}
                    onClick={({ key }) => setActiveTab(key as SettingsTab)}
                    items={settingsGroups}
                />
                <div className="settings-page-main-panel" key={activeTab}>
                    <section className="settings-page-section" aria-labelledby="settings-section-title">
                        <h1 id="settings-section-title">
                            {
                                settingsGroups.flatMap((group) => group.children).find((item) => item.key === activeTab)
                                    ?.label
                            }
                        </h1>
                        {activeTab === 'model' && <ModelProviderPanel />}
                        {activeTab === 'memory' && <MemoryPanel />}
                        {activeTab === 'persona' && <PersonaPanel />}
                        {activeTab === 'context' && <ContextCompactPanel />}
                        {activeTab === 'guard' && <AgentGuardPanel />}
                        {activeTab === 'permission' && <PermissionPanel />}
                        {activeTab === 'hooks' && <HooksPanel />}
                        {activeTab === 'commands' && <CommandPanel />}
                        {activeTab === 'web' && <WebAccessPanel />}
                        {activeTab === 'channel' && <ChannelPanel />}
                        {activeTab === 'env' && <EnvVarPanel />}
                        {activeTab === 'logs' && <LogPanel />}
                        {activeTab === 'recycle' && <RecycleBinPanel />}
                        {activeTab === 'app' && (
                            <div className="settings-page-app-panel">
                                <div className="settings-page-toolbar">
                                    <span className="settings-page-hint">应用级偏好与配置导入导出</span>
                                    <Space>
                                        <Button
                                            icon={<ExportOutlined />}
                                            loading={exporting}
                                            onClick={handleExportSettings}
                                        >
                                            导出配置
                                        </Button>
                                        <Upload
                                            accept="application/json,.json"
                                            showUploadList={false}
                                            beforeUpload={handleImportFile}
                                        >
                                            <Button icon={<ImportOutlined />} loading={importing}>
                                                导入配置
                                            </Button>
                                        </Upload>
                                    </Space>
                                </div>
                                <div className="settings-page-preference">
                                    <div className="settings-page-preference-label">默认对话模式</div>
                                    <Radio.Group
                                        value={defaultAgentMode}
                                        disabled={agentModeSaving}
                                        onChange={(e) => handleChangeAgentMode(e.target.value as AgentMode)}
                                        options={[
                                            { value: 'routed', label: 'Routed（默认，加载全部工具）' },
                                            { value: 'progressive', label: 'Progressive（按需加载工具，省上下文）' }
                                        ]}
                                    />
                                </div>
                                <div className="settings-page-preference">
                                    <div className="settings-page-preference-label">主题</div>
                                    <ThemeSwitcher />
                                </div>
                                <div className="settings-page-preference">
                                    <div className="settings-page-preference-label">初始化引导</div>
                                    <Button icon={<ReloadOutlined />} onClick={handleResetOnboarding}>
                                        恢复初始化配置
                                    </Button>
                                    <span className="settings-page-hint" style={{ marginLeft: 12 }}>
                                        重新进入引导页，不会清空已配置的模型
                                    </span>
                                </div>
                                <AppUpdatePanel />
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}

export default SettingsPage;
