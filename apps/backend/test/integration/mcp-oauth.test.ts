import fs from 'node:fs/promises';
import path from 'node:path';

import type { OAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    clearPendingAuth,
    completePendingAuth,
    consumeOAuthState,
    createOAuthFlow,
    createOAuthState,
    getPendingAuth,
    MCPOAuthProvider,
    OAuthTokenStore,
    resolveOAuthState,
    setConfigResolver,
    setPendingAuth,
    tokenStore
} from '@/modules/mcp/oauth';

import { createTempData } from '../helpers/temp-data';

const metadata: OAuthClientMetadata = { redirect_uris: ['http://localhost:31007/api/mcp/oauth/callback'] };
const tokens: OAuthTokens = { access_token: 'fixture-access', token_type: 'Bearer', refresh_token: 'fixture-refresh' };

describe('OAuth real persistence and orchestration with fake SDK boundary', () => {
    let temp: Awaited<ReturnType<typeof createTempData>>;
    let file: string;
    let store: OAuthTokenStore;
    let stores: OAuthTokenStore[];

    beforeEach(async () => {
        temp = await createTempData('mcp-oauth-');
        file = path.join(temp.root, 'private', 'oauth.json');
        store = new OAuthTokenStore(file);
        stores = [store];
        vi.stubEnv('PORT', '31007');
    });

    afterEach(async () => {
        for (const instance of stores) await instance.flush();
        await tokenStore.flush();
        setConfigResolver(() => undefined);
        clearPendingAuth('fixture-server');
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        await temp.cleanup();
    });

    function fakeSDK(info: OAuthServerInfo = { authorizationServerUrl: 'https://auth.invalid' }) {
        return {
            discoverOAuthServerInfo: vi.fn(async () => info),
            startAuthorization: vi.fn(async (_url, options) => ({
                authorizationUrl: new URL(`https://auth.invalid/authorize?state=${options.state}`),
                codeVerifier: 'fixture-pkce'
            })),
            exchangeAuthorization: vi.fn(async () => tokens)
        } satisfies NonNullable<Parameters<typeof createOAuthFlow>[0]>['sdk'];
    }

    it('serializes queued mutations, restores every field after restart and enforces 0600 on an existing file', async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, '{}', { mode: 0o644 });
        await fs.chmod(file, 0o644);
        store.setTokens('fixture-server', tokens);
        store.setClientInformation('fixture-server', { client_id: 'fixture-client' });
        store.setCodeVerifier('fixture-server', 'fixture-verifier');
        store.setDiscoveryState('fixture-server', {
            authorizationServerUrl: 'https://auth.invalid',
            resourceMetadataUrl: 'https://resource.invalid'
        });
        store.setTokens('deleted', tokens);
        store.clear('deleted');
        expect(store.getTokens('fixture-server')).toEqual(tokens);
        await store.flush();
        const expected = {
            tokens,
            clientInformation: { client_id: 'fixture-client' },
            codeVerifier: 'fixture-verifier',
            discoveryState: {
                authorizationServerUrl: 'https://auth.invalid',
                resourceMetadataUrl: 'https://resource.invalid'
            }
        };
        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ 'fixture-server': expected });
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
        expect(await fs.readdir(path.dirname(file))).toEqual(['oauth.json']);
        const restarted = new OAuthTokenStore(file);
        stores.push(restarted);
        expect(restarted.get('fixture-server')).toEqual(expected);
        expect(restarted.get('deleted')).toEqual({});
        restarted.clear('fixture-server');
        await restarted.flush();
        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ deleted: {} });
    });

    it('degrades malformed/non-object JSON to empty store and keeps memory usable after write failure', async () => {
        await fs.writeFile(path.join(temp.root, 'corrupt.json'), '{broken');
        const corrupt = new OAuthTokenStore(path.join(temp.root, 'corrupt.json'));
        stores.push(corrupt);
        expect(corrupt.getTokens('fixture-server')).toBeUndefined();
        await fs.writeFile(path.join(temp.root, 'null.json'), 'null');
        const invalid = new OAuthTokenStore(path.join(temp.root, 'null.json'));
        stores.push(invalid);
        expect(invalid.get('fixture-server')).toEqual({});
        const blockedParent = path.join(temp.root, 'not-directory');
        await fs.writeFile(blockedParent, 'blocking file');
        const failed = new OAuthTokenStore(path.join(blockedParent, 'oauth.json'));
        stores.push(failed);
        failed.setTokens('fixture-server', tokens);
        await expect(failed.flush()).resolves.toBeUndefined();
        expect(failed.getTokens('fixture-server')).toEqual(tokens);
        await fs.rm(blockedParent);
        failed.setCodeVerifier('fixture-server', 'after-failure');
        await failed.flush();
        expect(JSON.parse(await fs.readFile(path.join(blockedParent, 'oauth.json'), 'utf8'))).toEqual({
            'fixture-server': { tokens, codeVerifier: 'after-failure' }
        });
    });

    it('uses actual provider methods for metadata, redirect, client, tokens and verifier', async () => {
        const provider = new MCPOAuthProvider('fixture-server', metadata.redirect_uris[0], metadata, store);
        expect(provider.redirectUrl).toBe(metadata.redirect_uris[0]);
        expect(provider.clientMetadata).toBe(metadata);
        expect(provider.clientInformation()).toBeUndefined();
        expect(provider.tokens()).toBeUndefined();
        expect(provider.authorizationUrl).toBeUndefined();
        expect(() => provider.codeVerifier()).toThrow('No code verifier stored');
        provider.saveClientInformation({ client_id: 'fixture-id', client_secret: 'fixture-client-secret' });
        provider.saveTokens(tokens);
        provider.saveCodeVerifier('fixture-pkce');
        const redirect = new URL('https://auth.invalid/authorize');
        provider.redirectToAuthorization(redirect);
        expect(provider.authorizationUrl).toBe(redirect);
        expect(provider.clientInformation()).toEqual({
            client_id: 'fixture-id',
            client_secret: 'fixture-client-secret'
        });
        expect(provider.tokens()).toEqual(tokens);
        expect(provider.codeVerifier()).toBe('fixture-pkce');
        await store.flush();
        expect(JSON.parse(await fs.readFile(file, 'utf8'))['fixture-server'].tokens).toEqual(tokens);
    });

    it('keeps default provider/store entrypoints lazy and compatible with singleton persistence', async () => {
        // 公共 setup 已在导入前把 home 和所有路径 env 指到临时目录；此用例只测默认单例接线。
        const provider = new MCPOAuthProvider('singleton-fixture', 'http://localhost/callback', metadata);
        provider.saveClientInformation({ client_id: 'fixture-client' });
        provider.saveTokens(tokens);
        provider.saveCodeVerifier('fixture-verifier');
        tokenStore.setDiscoveryState('singleton-fixture', { authorizationServerUrl: 'https://auth.invalid' });
        expect(tokenStore.get('singleton-fixture')).toEqual({
            tokens,
            clientInformation: { client_id: 'fixture-client' },
            codeVerifier: 'fixture-verifier',
            discoveryState: { authorizationServerUrl: 'https://auth.invalid' }
        });
        expect(provider.clientInformation()).toEqual(tokenStore.getClientInformation('singleton-fixture'));
        expect(provider.codeVerifier()).toBe(tokenStore.getCodeVerifier('singleton-fixture'));
        expect(provider.tokens()).toEqual(tokenStore.getTokens('singleton-fixture'));
        expect(tokenStore.getDiscoveryState('singleton-fixture')).toEqual({
            authorizationServerUrl: 'https://auth.invalid'
        });
        tokenStore.clear('singleton-fixture');
        await tokenStore.flush();
        expect(tokenStore.getTokens('singleton-fixture')).toBeUndefined();
    });

    it('tracks pending replacement, completion, clearing and missing names independently', () => {
        completePendingAuth('absent');
        expect(getPendingAuth('absent')).toBeUndefined();
        setPendingAuth('fixture-server', 'https://auth.invalid/first');
        expect(getPendingAuth('fixture-server')).toEqual({
            authorizationUrl: 'https://auth.invalid/first',
            completed: false
        });
        completePendingAuth('fixture-server');
        expect(getPendingAuth('fixture-server')?.completed).toBe(true);
        setPendingAuth('fixture-server', 'https://auth.invalid/replaced');
        expect(getPendingAuth('fixture-server')).toEqual({
            authorizationUrl: 'https://auth.invalid/replaced',
            completed: false
        });
        clearPendingAuth('fixture-server');
        expect(getPendingAuth('fixture-server')).toBeUndefined();
    });

    it('accepts random state exactly once, rejects replaced/consumed/missing state', () => {
        expect(resolveOAuthState(undefined)).toBeUndefined();
        expect(resolveOAuthState('forged')).toBeUndefined();
        const replaced = createOAuthState('fixture-server');
        const current = createOAuthState('fixture-server');
        expect(current).not.toBe(replaced);
        expect(resolveOAuthState(replaced)).toBeUndefined();
        expect(resolveOAuthState(current)).toBe('fixture-server');
        expect(resolveOAuthState(current)).toBeUndefined();
        consumeOAuthState(current);
        const consumed = createOAuthState('fixture-server');
        consumeOAuthState(consumed);
        expect(resolveOAuthState(consumed)).toBeUndefined();
    });

    it('runs discovery, PKCE, state, pre-registered client and exchange through fake SDK; restart keeps token', async () => {
        const sdk = fakeSDK({
            authorizationServerUrl: 'https://auth.invalid',
            resourceMetadata: { resource: 'https://resource.invalid' }
        });
        const flow = createOAuthFlow({ store, sdk });
        const started = await flow.startOAuthFlow(
            'fixture-server',
            'https://resource.invalid/mcp',
            metadata.redirect_uris[0],
            metadata,
            'read write',
            'registered-id'
        );
        expect(sdk.discoverOAuthServerInfo).toHaveBeenCalledWith('https://resource.invalid/mcp');
        expect(sdk.startAuthorization).toHaveBeenCalledWith(
            'https://auth.invalid',
            expect.objectContaining({
                clientInformation: { client_id: 'registered-id' },
                redirectUrl: metadata.redirect_uris[0],
                scope: 'read write',
                metadata: undefined
            })
        );
        const state = new URL(started.authorizationUrl!).searchParams.get('state')!;
        expect(resolveOAuthState(state)).toBe('fixture-server');
        setPendingAuth('fixture-server', started.authorizationUrl!);
        const resolver = vi.fn(() => ({ oauth: { scope: 'read write' } }));
        setConfigResolver(resolver);
        expect(await flow.completeOAuthFlow('fixture-server', 'fixture-code')).toEqual(tokens);
        expect(resolver).toHaveBeenCalledWith('fixture-server');
        expect(sdk.exchangeAuthorization).toHaveBeenCalledWith('https://auth.invalid', {
            clientInformation: { client_id: 'registered-id' },
            authorizationCode: 'fixture-code',
            codeVerifier: 'fixture-pkce',
            redirectUri: metadata.redirect_uris[0]
        });
        expect(getPendingAuth('fixture-server')?.completed).toBe(true);
        await store.flush();
        const restarted = new OAuthTokenStore(file);
        stores.push(restarted);
        expect(restarted.getTokens('fixture-server')).toEqual(tokens);
        expect(restarted.getDiscoveryState('fixture-server')).toEqual({
            authorizationServerUrl: 'https://auth.invalid',
            resourceMetadataUrl: 'https://resource.invalid'
        });
        expect(
            await flow.startOAuthFlow('fixture-server', 'https://resource.invalid', metadata.redirect_uris[0], metadata)
        ).toEqual({ authenticated: true });
        expect(sdk.discoverOAuthServerInfo).toHaveBeenCalledTimes(1);
    });

    it('uses alias fallback, rejects dynamic registration and propagates discovery/start failures', async () => {
        const sdk = fakeSDK();
        const flow = createOAuthFlow({ store, sdk });
        await flow.startOAuthFlow('fixture-server', 'https://resource.invalid', metadata.redirect_uris[0], metadata);
        expect(store.getClientInformation('fixture-server')).toEqual({ client_id: 'alias' });
        const state = sdk.startAuthorization.mock.calls[0][1].state!;
        consumeOAuthState(state);
        sdk.discoverOAuthServerInfo.mockResolvedValueOnce({
            authorizationServerUrl: 'https://auth.invalid',
            authorizationServerMetadata: {
                issuer: 'https://auth.invalid',
                authorization_endpoint: 'https://auth.invalid/authorize',
                token_endpoint: 'https://auth.invalid/token',
                response_types_supported: ['code'],
                registration_endpoint: 'https://auth.invalid/register'
            }
        });
        await expect(
            flow.startOAuthFlow('registration', 'https://resource.invalid', metadata.redirect_uris[0], metadata)
        ).rejects.toThrow('动态注册');
        expect(sdk.startAuthorization).toHaveBeenCalledTimes(1);
        sdk.discoverOAuthServerInfo.mockRejectedValueOnce(new Error('discovery failure'));
        await expect(
            flow.startOAuthFlow('failure', 'https://resource.invalid', metadata.redirect_uris[0], metadata)
        ).rejects.toThrow('discovery failure');
        sdk.startAuthorization.mockRejectedValueOnce(new Error('start failure'));
        await expect(
            flow.startOAuthFlow('failure', 'https://resource.invalid', metadata.redirect_uris[0], metadata)
        ).rejects.toThrow('start failure');
        expect(store.getCodeVerifier('failure')).toBeUndefined();
    });

    it('rejects missing exchange prerequisites and does not mark failed exchange authenticated or completed', async () => {
        const sdk = fakeSDK();
        const flow = createOAuthFlow({ store, sdk });
        await expect(flow.completeOAuthFlow('fixture-server', 'code')).rejects.toThrow('No discovery state');
        store.setDiscoveryState('fixture-server', { authorizationServerUrl: 'https://auth.invalid' });
        await expect(flow.completeOAuthFlow('fixture-server', 'code')).rejects.toThrow('No client information');
        store.setClientInformation('fixture-server', { client_id: 'fixture-id' });
        await expect(flow.completeOAuthFlow('fixture-server', 'code')).rejects.toThrow('No code verifier');
        expect(sdk.exchangeAuthorization).not.toHaveBeenCalled();
        store.setCodeVerifier('fixture-server', 'fixture-pkce');
        setPendingAuth('fixture-server', 'https://auth.invalid/authorize');
        sdk.exchangeAuthorization.mockRejectedValueOnce(new Error('exchange failure'));
        await expect(flow.completeOAuthFlow('fixture-server', 'code')).rejects.toThrow('exchange failure');
        expect(store.getTokens('fixture-server')).toBeUndefined();
        expect(getPendingAuth('fixture-server')?.completed).toBe(false);
    });
});
