import fs from 'node:fs';
import os from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    vi.restoreAllMocks();
});

async function detect(
    platform: string,
    release: string,
    model = 'Generic CPU',
    arch: ReturnType<typeof os.arch> = 'x64',
    file?: string
) {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    const { hostOs } = await import('@/agent/tools/host-os');
    vi.spyOn(os, 'arch').mockReturnValue(arch);
    vi.spyOn(os, 'release').mockReturnValue(release);
    vi.spyOn(os, 'cpus').mockReturnValue(model ? [{ model } as os.CpuInfo] : []);
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        if (file === undefined) throw new Error('unavailable');
        return file;
    });
    return { hostOs, read };
}

describe('host OS hints without child processes', () => {
    it('reads macOS version and caches Apple Silicon identity', async () => {
        const { hostOs, read } = await detect(
            'darwin',
            '24.0.0',
            'Apple M4',
            'arm64',
            '<key>ProductVersion</key>\n<string> 15.5 </string>'
        );
        expect(hostOs()).toEqual({ family: 'macos', label: 'macOS 15.5（Apple Silicon, arm64）' });
        expect(hostOs()).toBe(hostOs());
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('labels Rosetta and falls back to Darwin when plist is unreadable', async () => {
        const { hostOs } = await detect('darwin', '24.0.0', 'Apple M1');
        expect(hostOs().label).toBe('macOS （Darwin 24.0.0）（Apple Silicon, x64（Rosetta 转译））');
    });

    it('labels Intel and tolerates a plist with no ProductVersion', async () => {
        const { hostOs } = await detect('darwin', '23.1', 'Intel i7', 'x64', '<plist/>');
        expect(hostOs().label).toContain('Intel, x64');
    });

    it('reads a quoted Linux name', async () => {
        const { hostOs } = await detect('linux', '6.8', '', 'arm64', 'NAME=Ubuntu\nPRETTY_NAME="Ubuntu 24.04 LTS"\n');
        expect(hostOs()).toEqual({ family: 'linux', label: 'Ubuntu 24.04 LTS（arm64）' });
    });

    it('reads an unquoted Linux name', async () => {
        const { hostOs } = await detect('linux', '6.8', 'CPU', 'x64', 'PRETTY_NAME=Debian GNU/Linux\n');
        expect(hostOs().label).toBe('Debian GNU/Linux（x64）');
    });

    it('falls back when Linux release metadata is absent', async () => {
        const { hostOs } = await detect('linux', '6.8');
        expect(hostOs().label).toBe('Linux 6.8（x64）');
    });

    it.each([
        ['10.0.22631', 'Windows 11'],
        ['10.0.22000', 'Windows 11'],
        ['10.0.19045', 'Windows 10'],
        ['unknown', 'Windows 10']
    ])('maps Windows build %s to %s', async (release, name) => {
        const { hostOs } = await detect('win32', release);
        expect(hostOs()).toEqual({ family: 'windows', label: `${name}（build ${release}，x64）` });
    });

    it('retains an unknown platform name', async () => {
        const { hostOs } = await detect('freebsd', '14.0');
        expect(hostOs()).toEqual({ family: 'other', label: 'freebsd 14.0（x64）' });
    });
});
