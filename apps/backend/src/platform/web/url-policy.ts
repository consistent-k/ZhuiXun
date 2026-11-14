import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Web 访问的错误码。工具层据此返回结构化错误，前端不依赖具体文案。
 */
export type WebErrorCode =
    | 'INVALID_URL'
    | 'BLOCKED_HOST'
    | 'DISABLED'
    | 'DNS_FAILED'
    | 'TIMEOUT'
    | 'TOO_LARGE'
    | 'UNSUPPORTED_CONTENT_TYPE'
    | 'EMPTY_CONTENT'
    | 'HTTP_ERROR'
    | 'NETWORK_ERROR';

/** 受控 Web 访问的统一错误。status 仅在 HTTP_ERROR 时有值。 */
export class WebAccessError extends Error {
    constructor(
        readonly code: WebErrorCode,
        message: string,
        readonly status?: number
    ) {
        super(message);
        this.name = 'WebAccessError';
    }
}

export interface HostPolicy {
    /** 非空时即为白名单；支持 `example.com` / `*.example.com`。 */
    allowedHosts: string[];
    /** 黑名单，优先于白名单。 */
    blockedHosts: string[];
}

export interface PinnedAddress {
    address: string;
    family: 4 | 6;
}

/** 只允许标准 Web 端口，避免工具被当成端口扫描器。 */
const ALLOWED_PORTS = new Set([80, 443]);

/** 这些后缀一定是本机 / 内网语义，无需 DNS 解析即可拒绝。 */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** 云厂商元数据 / 本机别名。 */
const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'metadata',
    'metadata.google.internal',
    'instance-data',
    'instance-data.ec2.internal'
]);

function hostWithoutTrailingDot(hostname: string): string {
    return hostname.toLowerCase().replace(/\.+$/, '');
}

/** 单条 host 规则匹配：`*` 全匹配，`*.example.com` 匹配子域与自身。 */
export function matchesHost(host: string, pattern: string): boolean {
    const p = pattern.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
    if (!p) return false;
    if (p === '*') return true;
    if (p.startsWith('*.')) {
        const base = p.slice(2);
        return host === base || host.endsWith(`.${base}`);
    }
    return host === p;
}

function matchesAnyHost(host: string, patterns: string[]): boolean {
    return patterns.some((pattern) => matchesHost(host, pattern));
}

function parseIpv4(ip: string): number[] | null {
    const parts = ip.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return parts;
}

/**
 * 公网 IPv4 判定（拒绝环回 / 私网 / 链路本地 / 组播 / 保留 / 文档段）。
 * 用显式拒绝表而非「仅允许公网段」，避免误伤合法但少见的公网地址。
 */
function isPublicIpv4(ip: string): boolean {
    const parts = parseIpv4(ip);
    if (!parts) return false;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
    if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
    if (a >= 224) return false; // multicast + reserved + broadcast
    return true;
}

/** 公网 IPv6 判定。IPv4-mapped / NAT64 形式拆出内嵌 IPv4 再判定。 */
function isPublicIpv6(ip: string): boolean {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return false;

    // 点分形式（部分解析器会保留）：::ffff:127.0.0.1 / 64:ff9b::10.0.0.1
    const dotted = s.match(/^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPublicIpv4(dotted[1]);

    // 十六进制形式：WHATWG URL 会把 ::ffff:127.0.0.1 归一成 ::ffff:7f00:1。
    // 不处理这一形态会让 IPv4-mapped 环回 / 私网地址绕过检查。
    if (s.startsWith('::ffff:') || s.startsWith('64:ff9b::') || s.startsWith('::')) {
        const tail = s.match(/(?:^|:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (tail) {
            const high = parseInt(tail[1], 16);
            const low = parseInt(tail[2], 16);
            return isPublicIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
        }
    }

    if (/^f[cd]/.test(s)) return false; // fc00::/7 unique local
    if (/^fe[89ab]/.test(s)) return false; // fe80::/10 link local
    if (/^ff/.test(s)) return false; // multicast
    if (s.startsWith('2001:db8:')) return false; // documentation
    // 其余 `::` 开头（`::/96`、IPv4-compatible 等）都属于保留 / 特殊段，一律不放行
    if (s.startsWith('::')) return false;
    return true;
}

function isPublicIp(ip: string): boolean {
    const version = isIP(ip);
    if (version === 4) return isPublicIpv4(ip);
    if (version === 6) return isPublicIpv6(ip);
    return false;
}

function assertPublicHost(host: string): void {
    if (BLOCKED_HOSTNAMES.has(host)) {
        throw new WebAccessError('BLOCKED_HOST', `拒绝访问本机 / 元数据地址：${host}`);
    }
    if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
        throw new WebAccessError('BLOCKED_HOST', `拒绝访问本机 / 内网域名：${host}`);
    }
    if (isIP(host) && !isPublicIp(host)) {
        throw new WebAccessError('BLOCKED_HOST', `拒绝访问非公网地址：${host}`);
    }
}

/**
 * 解析并校验 URL：协议、端口、userinfo、host 黑白名单、IP 字面量。
 * 重定向的每一跳都要重新调用（见 fetcher）。
 */
export function parseAndValidateUrl(raw: string, policy: HostPolicy): URL {
    const text = raw.trim();
    if (!text) throw new WebAccessError('INVALID_URL', 'URL 不能为空');

    let url: URL;
    try {
        url = new URL(text);
    } catch {
        throw new WebAccessError('INVALID_URL', `无效 URL：${text}`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new WebAccessError('INVALID_URL', `仅支持 http/https，收到：${url.protocol}`);
    }
    if (url.username || url.password) {
        throw new WebAccessError('INVALID_URL', 'URL 不能包含用户名或密码');
    }

    // WHATWG URL 的 IPv6 hostname 带方括号（`[::1]`），IP 判定与匹配要用裸地址。
    const bracketed = hostWithoutTrailingDot(url.hostname);
    const host = bracketed.startsWith('[') && bracketed.endsWith(']') ? bracketed.slice(1, -1) : bracketed;
    if (!host) throw new WebAccessError('INVALID_URL', 'URL 缺少主机名');

    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!ALLOWED_PORTS.has(port)) {
        throw new WebAccessError('INVALID_URL', `仅允许 80/443 端口，收到：${port}`);
    }

    assertPublicHost(host);

    if (matchesAnyHost(host, policy.blockedHosts)) {
        throw new WebAccessError('BLOCKED_HOST', `域名在禁止列表中：${host}`);
    }
    if (policy.allowedHosts.length > 0 && !matchesAnyHost(host, policy.allowedHosts)) {
        throw new WebAccessError('BLOCKED_HOST', `域名不在允许列表中：${host}`);
    }

    // 规范化后的 hostname 写回，保证后续建连与审计使用同一形态。
    // IPv6 字面量保持原样（裸地址不能直接赋给 URL.hostname）。
    if (!bracketed.startsWith('[')) url.hostname = host;
    return url;
}

/**
 * 解析域名并校验所有 A/AAAA 记录，返回一个可钉死的公网地址。
 *
 * 关键：**任意一条记录落在内网即拒绝**（而不是只看第一条），否则攻击者可以用
 * 一条公网记录 + 一条内网记录做 DNS rebinding。调用方必须用返回的 address 建连，
 * 不能再次解析主机名。
 */
export async function resolvePublicAddress(host: string): Promise<PinnedAddress> {
    // URL.hostname 对 IPv6 字面量保留方括号（`[2606:...]`），解析与判定要用裸地址
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    const version = isIP(bare);
    if (version === 4 || version === 6) {
        if (!isPublicIp(bare)) throw new WebAccessError('BLOCKED_HOST', `拒绝访问非公网地址：${bare}`);
        return { address: bare, family: version };
    }

    let records: Array<{ address: string; family: number }>;
    try {
        records = await lookup(bare, { all: true, order: 'verbatim' });
    } catch {
        throw new WebAccessError('DNS_FAILED', `域名解析失败：${bare}`);
    }
    if (records.length === 0) throw new WebAccessError('DNS_FAILED', `域名没有可用地址：${bare}`);

    for (const record of records) {
        if (!isPublicIp(record.address)) {
            throw new WebAccessError('BLOCKED_HOST', `域名解析到非公网地址：${bare} -> ${record.address}`);
        }
    }

    const first = records[0];
    return { address: first.address, family: first.family === 6 ? 6 : 4 };
}
