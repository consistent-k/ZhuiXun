type EnvKey =
    | 'NODE_ENV'
    | 'API_AUTH_TOKEN'
    | 'ALLOWED_ORIGINS'
    | 'SESSIONS_USER_DIR'
    | 'PROJECTS_USER_DIR'
    | 'TASKS_USER_DIR'
    | 'MEMORY_USER_DIR'
    | 'PERMISSION_USER_DIR'
    | 'SETTINGS_CONFIG_PATH'
    | 'MCP_CONFIG_PATH'
    | 'MCP_OAUTH_PATH'
    | 'STREAMS_USER_DIR'
    | 'LOG_DIR'
    | 'CHANNELS_USER_DIR'
    | 'SKILLS_USER_DIR'
    | 'SKILLS_EXTERNAL_DIRS';

export function snapshotEnv(keys: readonly EnvKey[]): () => void {
    const values = new Map<EnvKey, string | undefined>();
    for (const key of keys) values.set(key, process.env[key]);

    return () => {
        for (const key of keys) {
            const value = values.get(key);
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}

export function setEnv(values: Partial<Record<EnvKey, string | undefined>>): () => void {
    const restore = snapshotEnv(Object.keys(values) as EnvKey[]);
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key as EnvKey] = value;
    }
    return restore;
}
