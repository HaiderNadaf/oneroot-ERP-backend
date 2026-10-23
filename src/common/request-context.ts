import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/** Where a request came from: the browser's own device id, a readable device name, its IP and raw user agent */
export interface RequestDevice {
  deviceId: string | null;
  deviceName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestDevice>();

/** The device of the request being handled; null outside a request (start-up and background jobs) */
export const currentDevice = () => storage.getStore() ?? null;

/** What the browser reports about itself (Chrome / Edge client hints), sent as X-Device-Info */
export interface DeviceInfo {
  /** Phone / tablet model, e.g. "SM-A146B" (empty on computers) */
  model?: string;
  /** "Windows", "macOS", "Android", "Chrome OS", "Linux" */
  platform?: string;
  /** e.g. "15.0.0" (Windows 11), "14.5.0" (macOS), "14.0.0" (Android) */
  platformVersion?: string;
  /** e.g. "Google Chrome", "Microsoft Edge" */
  browser?: string;
  /** e.g. "141.0.7390.55" */
  browserVersion?: string;
  mobile?: boolean;
}

/** Maker of an Android phone from its model code (the common Indian brands); null when unknown */
function makerOf(model: string) {
  const rules: [RegExp, string][] = [
    [/^SM-|^GT-|^Galaxy/i, 'Samsung'],
    [/^Pixel/i, 'Google'],
    [/^Redmi|^POCO|^Mi |^M2\d{3}|^2\d{5,}|^2\d{3}[A-Z0-9]{3,}/i, 'Xiaomi'],
    [/^RMX/i, 'realme'],
    [/^CPH|^OPPO/i, 'OPPO'],
    [/^V2\d{3}|^vivo|^I2\d{3}/i, 'vivo'],
    [/^ONEPLUS|^OnePlus|^NE2|^LE2|^KB2|^IN2|^AC2/i, 'OnePlus'],
    [/^moto|^XT\d/i, 'Motorola'],
    [/^Nokia|^TA-/i, 'Nokia'],
    [/^Infinix|^X6\d{2}/i, 'Infinix'],
    [/^TECNO/i, 'TECNO'],
    [/^iQOO/i, 'iQOO'],
    [/^Lenovo|^TB-/i, 'Lenovo'],
    [/^ASUS/i, 'ASUS'],
    [/^Nothing|^A06\d/i, 'Nothing'],
  ];
  return rules.find(([re]) => re.test(model))?.[1] ?? null;
}

const major = (v?: string | null) => (v ? v.split('.')[0] : '');

/** "Windows 11", "macOS 14.5", "Android 14", from client hints */
function osFromHints(platform?: string, version?: string) {
  if (!platform) return null;
  if (platform === 'Windows') {
    // Client hints: 13 and above is Windows 11, 1–10 is Windows 10, 0 is Windows 7 / 8
    const m = Number(major(version));
    return Number.isNaN(m) || !version ? 'Windows' : m >= 13 ? 'Windows 11' : m > 0 ? 'Windows 10' : 'Windows 7/8';
  }
  if (platform === 'macOS') return version ? `macOS ${version.split('.').slice(0, 2).join('.').replace(/\.0$/, '')}` : 'macOS';
  if (platform === 'Android') return version ? `Android ${major(version)}` : 'Android';
  return version && platform !== 'Linux' ? `${platform} ${major(version)}` : platform;
}

/** Short browser name: "Google Chrome" -> "Chrome", "Microsoft Edge" -> "Edge" */
const browserShort = (b?: string) => (b ? b.replace(/^Google /, '').replace(/^Microsoft /, '') : null);

/** The best name the request tells: model · OS with version · browser with version, e.g. "Samsung SM-A146B · Android 14 · Chrome 141" */
export function describeDevice(ua: string | null | undefined, info?: DeviceInfo | null): string | null {
  if (info?.platform) {
    const model = info.model?.trim();
    const maker = model ? makerOf(model) : null;
    const parts = [
      model ? (maker && !model.toLowerCase().startsWith(maker.toLowerCase()) ? `${maker} ${model}` : model) : null,
      osFromHints(info.platform, info.platformVersion),
      info.browser ? `${browserShort(info.browser)} ${major(info.browserVersion)}`.trim() : null,
    ];
    return parts.filter(Boolean).join(' · ');
  }
  return describeFromUserAgent(ua);
}

/** For browsers that send no client hints (Safari, Firefox): read what the user agent gives */
function describeFromUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const v = (re: RegExp) => ua.match(re)?.[1] ?? null;
  const browser = /Edg(?:A|iOS)?\//.test(ua)
    ? `Edge ${v(/Edg(?:A|iOS)?\/(\d+)/)}`
    : /OPR\/|Opera/.test(ua)
      ? `Opera ${v(/OPR\/(\d+)/) ?? ''}`.trim()
      : /SamsungBrowser/.test(ua)
        ? `Samsung Internet ${v(/SamsungBrowser\/(\d+)/)}`
        : /Firefox\/|FxiOS/.test(ua)
          ? `Firefox ${v(/(?:Firefox|FxiOS)\/(\d+)/)}`
          : /Chrome\/|CriOS/.test(ua)
            ? `Chrome ${v(/(?:Chrome|CriOS)\/(\d+)/)}`
            : /Safari\//.test(ua)
              ? `Safari ${v(/Version\/(\d+(?:\.\d+)?)/) ?? ''}`.trim()
              : null;
  // Android user agents still name the model, unless reduced to "K"
  const androidModel = v(/Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?\)/);
  const model = androidModel && androidModel !== 'K' ? androidModel.trim() : null;
  const os = /iPhone/.test(ua)
    ? `iPhone · iOS ${v(/iPhone OS (\d+(?:_\d+)?)/)?.replace('_', '.') ?? ''}`.trim()
    : /iPad/.test(ua)
      ? `iPad · iPadOS ${v(/CPU OS (\d+(?:_\d+)?)/)?.replace('_', '.') ?? ''}`.trim()
      : /Android/.test(ua)
        ? [model ? `${makerOf(model) ? `${makerOf(model)} ` : ''}${model}` : /Mobile/.test(ua) ? 'Android phone' : 'Android tablet', `Android ${v(/Android (\d+)/) ?? ''}`.trim()].join(' · ')
        : /Windows NT 10/.test(ua)
          ? 'Windows 10/11'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Mac OS X|Macintosh/.test(ua)
              ? 'Mac'
              : /CrOS/.test(ua)
                ? 'Chromebook'
                : /Linux/.test(ua)
                  ? 'Linux'
                  : null;
  if (browser && os) return `${os} · ${browser}`;
  return os ?? browser ?? ua.slice(0, 60);
}

/** X-Device-Info: URI-encoded JSON from the browser; only short plain strings are kept */
function parseInfo(raw: unknown): DeviceInfo | null {
  if (typeof raw !== 'string' || !raw || raw.length > 1000) return null;
  try {
    const o = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).replace(/[^\p{L}\p{N} ._()+/-]/gu, '').slice(0, 60) : undefined);
    return { model: str('model'), platform: str('platform'), platformVersion: str('platformVersion'), browser: str('browser'), browserVersion: str('browserVersion'), mobile: o.mobile === true };
  } catch {
    return null;
  }
}

/** The caller's address: the first X-Forwarded-For hop behind a proxy, else the socket address */
function clientIp(req: Request) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  const ip = forwarded || req.socket?.remoteAddress || null;
  // IPv4 seen through an IPv6 socket: ::ffff:10.0.0.5 -> 10.0.0.5
  return ip?.replace(/^::ffff:/, '') ?? null;
}

/**
 * Runs each request inside its own context holding the device it came from, so the audit log can
 * record it without every service passing it along. The browser sends its device id as X-Device-Id
 * and, where it can tell (Chrome, Edge), its model, OS version and browser version as X-Device-Info.
 */
export function requestContext(req: Request, _res: Response, next: NextFunction) {
  const rawId = String(req.headers['x-device-id'] ?? '').trim();
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 500) || null;
  storage.run(
    {
      // Only a plain id is kept (the browser makes a UUID); anything else is ignored
      deviceId: /^[A-Za-z0-9-]{8,64}$/.test(rawId) ? rawId : null,
      deviceName: describeDevice(ua, parseInfo(req.headers['x-device-info'])),
      ipAddress: clientIp(req),
      userAgent: ua,
    },
    next,
  );
}
