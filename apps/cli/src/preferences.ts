import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = path.join(os.homedir(), '.zhuixun');
const filename = path.join(directory, 'cli-preferences.json');

export const themes = ['dark', 'light', 'mayday'] as const;
export const locales = ['zh', 'en'] as const;
export interface Preferences {
    theme: (typeof themes)[number];
    locale: (typeof locales)[number];
}

export async function loadPreferences(): Promise<Preferences> {
    try {
        const stored = JSON.parse(await readFile(filename, 'utf8')) as Partial<Preferences>;
        return {
            theme: stored.theme && themes.includes(stored.theme) ? stored.theme : 'mayday',
            locale: stored.locale && locales.includes(stored.locale) ? stored.locale : 'zh'
        };
    } catch {
        return { theme: 'mayday', locale: 'zh' };
    }
}

export async function savePreferences(preferences: Preferences): Promise<void> {
    await mkdir(directory, { recursive: true });
    const temporary = filename + '.' + process.pid + '.tmp';
    try {
        await writeFile(temporary, JSON.stringify(preferences) + '\n', { mode: 0o600 });
        await rename(temporary, filename);
    } finally {
        await rm(temporary, { force: true });
    }
}
