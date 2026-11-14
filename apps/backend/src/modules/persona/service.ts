import { randomUUID } from 'node:crypto';

import type { PersonaConfigView, PersonaCreateInput, PersonaUpdateInput, PersonaView } from '@zhuixun/shared';

import { getPersonaSettings, setPersonaSettings, type PersonaRecord } from '@/config/settings-store';
import { createLogger } from '@/platform/logging/index';

import { BUILTIN_PERSONAS, DEFAULT_PERSONA_ID } from './presets';

const log = createLogger('Persona');

/** 自定义风格数量与单段指令上限；用于控制配置复杂度与提示词体积。 */
export const PERSONA_LIMITS = {
    maxCustom: 20,
    maxNameLength: 30,
    maxDescriptionLength: 100,
    maxInstructionLength: 2000
} as const;

/** 带 HTTP 语义的风格业务错误。 */
export class PersonaError extends Error {
    constructor(
        readonly status: 400 | 404,
        message: string
    ) {
        super(message);
        this.name = 'PersonaError';
    }
}

const RESERVED_DELIMITER_RE = /<\/?zhuixun-persona-style>/gi;
const warnedMissingIds = new Set<string>();

function stripControlChars(value: string): string {
    return [...value]
        .filter((char) => {
            const code = char.charCodeAt(0);
            return !(code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31));
        })
        .join('');
}

function normalizeText(value: string): string {
    return stripControlChars(value.replace(/\r\n?/g, '\n')).trim();
}

function normalizeInstruction(value: string): string {
    return normalizeText(value.replace(RESERVED_DELIMITER_RE, ''));
}

function isPersonaRecord(value: unknown): value is PersonaRecord {
    if (!value || typeof value !== 'object') return false;
    const record = value as Partial<PersonaRecord>;
    return (
        typeof record.id === 'string' &&
        record.id.startsWith('custom_') &&
        typeof record.name === 'string' &&
        typeof record.description === 'string' &&
        typeof record.instruction === 'string' &&
        typeof record.createdAt === 'number' &&
        Number.isFinite(record.createdAt) &&
        typeof record.updatedAt === 'number' &&
        Number.isFinite(record.updatedAt)
    );
}

function readConfig(): { defaultId: string; custom: PersonaRecord[] } {
    const raw = getPersonaSettings();
    const custom = (Array.isArray(raw.custom) ? raw.custom : [])
        .filter(isPersonaRecord)
        .slice(0, PERSONA_LIMITS.maxCustom);
    return {
        defaultId: typeof raw.defaultId === 'string' && raw.defaultId ? raw.defaultId : DEFAULT_PERSONA_ID,
        custom
    };
}

function toView(record: PersonaRecord): PersonaView {
    return {
        id: record.id,
        name: record.name,
        description: record.description,
        instruction: record.instruction,
        kind: 'custom',
        updatedAt: record.updatedAt
    };
}

function validateName(value: string): string {
    const name = normalizeText(value);
    if (!name) throw new PersonaError(400, '风格名称不能为空');
    if ([...name].length > PERSONA_LIMITS.maxNameLength) {
        throw new PersonaError(400, `风格名称不能超过 ${PERSONA_LIMITS.maxNameLength} 个字符`);
    }
    return name;
}

function validateDescription(value: string | undefined): string {
    const description = normalizeText(value ?? '');
    if ([...description].length > PERSONA_LIMITS.maxDescriptionLength) {
        throw new PersonaError(400, `风格简介不能超过 ${PERSONA_LIMITS.maxDescriptionLength} 个字符`);
    }
    return description;
}

function validateInstruction(value: string): string {
    const instruction = normalizeInstruction(value);
    if (!instruction) throw new PersonaError(400, '风格指令不能为空');
    if ([...instruction].length > PERSONA_LIMITS.maxInstructionLength) {
        throw new PersonaError(400, `风格指令不能超过 ${PERSONA_LIMITS.maxInstructionLength} 个字符`);
    }
    return instruction;
}

/** 合并内置与自定义风格，并把失效默认值收敛到 default。 */
export function listPersonas(): PersonaConfigView {
    const { defaultId, custom } = readConfig();
    const customViews = [...custom].sort((a, b) => b.updatedAt - a.updatedAt).map(toView);
    const items = [...BUILTIN_PERSONAS, ...customViews];
    return {
        defaultId: items.some((item) => item.id === defaultId) ? defaultId : DEFAULT_PERSONA_ID,
        items
    };
}

/** 读取当前默认风格 id。 */
export function getDefaultPersonaId(): string {
    return listPersonas().defaultId;
}

/**
 * 按 id 解析风格；未知 id 回落到默认并只告警一次，避免失效会话每轮刷日志。
 * @param id 会话/请求指定的风格 id；缺省表示跟随默认
 */
export function resolvePersona(id?: string): PersonaView {
    const config = listPersonas();
    const requested = typeof id === 'string' && id.trim() ? id.trim() : '';
    const found = requested ? config.items.find((item) => item.id === requested) : undefined;
    if (found) return found;
    if (requested && !warnedMissingIds.has(requested) && warnedMissingIds.size < 50) {
        warnedMissingIds.add(requested);
        log.warn('风格不存在，已回落到默认风格', { requested });
    }
    return config.items.find((item) => item.id === config.defaultId) ?? BUILTIN_PERSONAS[0];
}

/** 新建自定义风格，返回更新后的完整配置。 */
export function createPersona(input: PersonaCreateInput): PersonaConfigView {
    const { custom } = readConfig();
    if (custom.length >= PERSONA_LIMITS.maxCustom) {
        throw new PersonaError(400, `自定义风格最多 ${PERSONA_LIMITS.maxCustom} 个`);
    }
    const now = Date.now();
    const record: PersonaRecord = {
        id: `custom_${randomUUID()}`,
        name: validateName(input.name),
        description: validateDescription(input.description),
        instruction: validateInstruction(input.instruction),
        createdAt: now,
        updatedAt: now
    };
    setPersonaSettings({ ...getPersonaSettings(), custom: [record, ...custom] });
    return listPersonas();
}

/** 更新自定义风格；内置风格不可修改。 */
export function updatePersona(id: string, patch: PersonaUpdateInput): PersonaConfigView {
    const { custom } = readConfig();
    const index = custom.findIndex((item) => item.id === id);
    if (index < 0) {
        if (BUILTIN_PERSONAS.some((item) => item.id === id)) {
            throw new PersonaError(400, '内置风格不可修改');
        }
        throw new PersonaError(404, '风格不存在');
    }
    const current = custom[index];
    const next: PersonaRecord = {
        ...current,
        name: patch.name === undefined ? current.name : validateName(patch.name),
        description: patch.description === undefined ? current.description : validateDescription(patch.description),
        instruction: patch.instruction === undefined ? current.instruction : validateInstruction(patch.instruction),
        updatedAt: Date.now()
    };
    const nextCustom = [...custom];
    nextCustom[index] = next;
    setPersonaSettings({ ...getPersonaSettings(), custom: nextCustom });
    return listPersonas();
}

/** 删除自定义风格；若它正被设为默认，默认值回落到 default。 */
export function deletePersona(id: string): PersonaConfigView {
    const { defaultId, custom } = readConfig();
    if (BUILTIN_PERSONAS.some((item) => item.id === id)) {
        throw new PersonaError(400, '内置风格不可删除');
    }
    if (!custom.some((item) => item.id === id)) {
        throw new PersonaError(404, '风格不存在');
    }
    setPersonaSettings({
        ...getPersonaSettings(),
        defaultId: defaultId === id ? DEFAULT_PERSONA_ID : defaultId,
        custom: custom.filter((item) => item.id !== id)
    });
    return listPersonas();
}

/** 设置默认风格；必须指向内置或现存自定义项。 */
export function setDefaultPersona(id: string): PersonaConfigView {
    const { items } = listPersonas();
    if (!items.some((item) => item.id === id)) {
        throw new PersonaError(404, '风格不存在');
    }
    setPersonaSettings({ ...getPersonaSettings(), defaultId: id });
    return listPersonas();
}
