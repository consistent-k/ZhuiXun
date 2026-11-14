/** persona 模块公开契约：内置/自定义表达风格与提示词注入。 */
export type { PersonaConfigView, PersonaCreateInput, PersonaUpdateInput, PersonaView } from '@zhuixun/shared';
export { BUILTIN_PERSONAS, DEFAULT_PERSONA_ID } from './presets';
export { buildPersonaSection } from './inject';
export {
    createPersona,
    deletePersona,
    getDefaultPersonaId,
    listPersonas,
    PERSONA_LIMITS,
    PersonaError,
    resolvePersona,
    setDefaultPersona,
    updatePersona
} from './service';
