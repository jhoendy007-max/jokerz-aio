/**
 * Chrome 131 stealth launcher (Target / Shape).
 * Real Chrome channel when installed; bundled Chromium fallback.
 * Per-task identity (GPU/viewport/hw) + WebRTC leak blocked.
 */
import { getIdentity, identityHint } from "./fp-identity.mjs";
import { geoForProxy, geoHint } from "./proxy-geo.mjs";

export const CHROME_131 = {
  major: "131",
  full: "131.0.6778.139",
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  secChUaFull:
    '"Google Chrome";v="131.0.6778.139", "Chromium";v="131.0.6778.139", "Not_A Brand";v="10.0.2.3"',
  platform: '"Windows"',
  platformVersion: "15.0.0",
};

export const CHROME_131_HEADERS = {
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": CHROME_131.secChUa,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": CHROME_131.platform,
  "sec-ch-ua-platform-version": `"${CHROME_131.platformVersion}"`,
  "sec-ch-ua-full-version-list": CHROME_131.secChUaFull,
  "sec-ch-ua-arch": '"x86"',
  "sec-ch-ua-bitness": '"64"',
  "sec-ch-ua-model": '""',
  "sec-ch-ua-wow64": "?0",
};

export function parseProxy(line) {
  if (!line) return undefined;
  let s = String(line).trim();
  if (!s) return undefined;
  s = s.replace(/^https?:\/\//i, "");
  if (s.includes("@")) {
    const [auth, host] = s.split("@");
    const [username, ...p] = auth.split(":");
    const [hostname, port] = host.split(":");
    return { server: `http://${hostname}:${port}`, username, password: p.join(":") };
  }
  const parts = s.split(":");
  if (parts.length >= 4) {
    const [host, port, username, ...rest] = parts;
    return { server: `http://${host}:${port}`, username, password: rest.join(":") };
  }
  if (parts.length === 2) return { server: `http://${parts[0]}:${parts[1]}` };
  return undefined;
}

function stealthInit(fp) {
  const FULL = fp.full;
  const MAJOR = fp.major;
  const cores = fp.cores || 8;
  const memory = fp.memory || 8;
  const gpuVendor = fp.gpuVendor || "Google Inc. (Intel)";
  const gpuRenderer =
    fp.gpuRenderer || "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)";
  const noise = Number(fp.canvasNoise) || 0;
  const audioN = Number(fp.audioNoise) || 0;
  const seed = (Number(fp.seed) >>> 0) || (((noise * 255) | 0) << 8) ^ (((audioN * 5000) | 0) + 1);

  const tpdf = (i) => {
    const a = (Math.imul(i + 1, seed ^ 0x9e3779b9) >>> 0) / 4294967296;
    const b = (Math.imul(i + 3, seed ^ 0x85ebca6b) >>> 0) / 4294967296;
    return a + b - 1;
  };

  const native = (fn, name) => {
    try {
      Object.defineProperty(fn, "name", { value: name });
      fn.toString = () => `function ${name}() { [native code] }`;
    } catch {
      /* */
    }
    return fn;
  };

  try {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });
  } catch {
    /* */
  }

  window.chrome = {
    runtime: {
      id: undefined,
      connect: native(() => ({}), "connect"),
      sendMessage: native(() => {}, "sendMessage"),
    },
    app: { isInstalled: false, getDetails: native(() => null, "getDetails") },
    csi: native(() => ({}), "csi"),
    loadTimes: native(
      () => ({
        requestTime: Date.now() / 1000 - 0.4,
        startLoadTime: Date.now() / 1000 - 0.3,
        commitLoadTime: Date.now() / 1000 - 0.2,
        finishDocumentLoadTime: Date.now() / 1000 - 0.1,
        finishLoadTime: Date.now() / 1000,
        firstPaintTime: Date.now() / 1000 - 0.15,
        firstPaintAfterLoadTime: 0,
        navigationType: "Other",
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: "h2",
        wasAlternateProtocolAvailable: false,
        connectionInfo: "h2",
      }),
      "loadTimes"
    ),
  };

  const pluginData = [
    { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
    { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
    { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
    { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
    { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format" },
  ];
  pluginData.item = (i) => pluginData[i] || null;
  pluginData.namedItem = (n) => pluginData.find((p) => p.name === n) || null;
  pluginData.refresh = () => {};
  Object.defineProperty(navigator, "plugins", { get: () => pluginData });
  Object.defineProperty(navigator, "mimeTypes", {
    get: () => {
      const m = [
        { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
        { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" },
      ];
      m.item = (i) => m[i] || null;
      m.namedItem = (n) => m.find((x) => x.type === n) || null;
      return m;
    },
  });

  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  Object.defineProperty(navigator, "language", { get: () => "en-US" });
  Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  Object.defineProperty(navigator, "hardwareConcurrency", { get: () => cores });
  Object.defineProperty(navigator, "deviceMemory", { get: () => memory });
  Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });
  Object.defineProperty(navigator, "vendor", { get: () => "Google Inc." });
  Object.defineProperty(navigator, "appVersion", {
    get: () =>
      `5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36`,
  });

  if (navigator.userAgentData) {
    const brands = [
      { brand: "Google Chrome", version: MAJOR },
      { brand: "Chromium", version: MAJOR },
      { brand: "Not_A Brand", version: "24" },
    ];
    const high = [
      { brand: "Google Chrome", version: FULL },
      { brand: "Chromium", version: FULL },
      { brand: "Not_A Brand", version: "10.0.2.3" },
    ];
    try {
      Object.defineProperty(navigator, "userAgentData", {
        get: () => ({
          brands,
          mobile: false,
          platform: "Windows",
          getHighEntropyValues: native(
            (hints) =>
              Promise.resolve({
                brands,
                fullVersionList: high,
                mobile: false,
                model: "",
                platform: "Windows",
                platformVersion: "15.0.0",
                uaFullVersion: FULL,
                architecture: "x86",
                bitness: "64",
                wow64: false,
              }),
            "getHighEntropyValues"
          ),
          toJSON: () => ({ brands, mobile: false, platform: "Windows" }),
        }),
      });
    } catch {
      /* */
    }
  }

  const origQuery = navigator.permissions?.query?.bind(navigator.permissions);
  if (origQuery) {
    navigator.permissions.query = native(
      (p) =>
        p && p.name === "notifications"
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : origQuery(p),
      "query"
    );
  }

  const patchGl = (proto) => {
    const getParam = proto.getParameter;
    const intel = /Intel/i.test(gpuRenderer);
    const maxTex = intel ? 16384 : 16384;
    proto.getParameter = native(function (p) {
      if (p === 37445) return gpuVendor;
      if (p === 37446) return gpuRenderer;
      if (fp.headed === false) {
        if (p === 3379 || p === 34076) return maxTex;
        if (p === 34024) return maxTex;
        if (p === 34930) return 16;
      }
      return getParam.call(this, p);
    }, "getParameter");
  };
  patchGl(WebGLRenderingContext.prototype);
  if (window.WebGL2RenderingContext) patchGl(WebGL2RenderingContext.prototype);

  try {
    if (navigator.mediaDevices) {
      const gid = String(seed || 1);
      const devices = [
        { deviceId: "default", kind: "audioinput", label: "", groupId: gid + "a" },
        { deviceId: "communications", kind: "audioinput", label: "", groupId: gid + "a" },
        { deviceId: "default", kind: "audiooutput", label: "", groupId: gid + "b" },
        { deviceId: gid + "cam", kind: "videoinput", label: "", groupId: gid + "c" },
      ];
      navigator.mediaDevices.enumerateDevices = native(
        () => Promise.resolve(devices.map((d) => ({ ...d, toJSON: () => d }))),
        "enumerateDevices"
      );
    }
  } catch {
    /* */
  }

  const toDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origGid = CanvasRenderingContext2D.prototype.getImageData;
  const ditherCanvas = (data) => {
    if (!data || !data.length) return;
    for (let i = 0; i < data.length; i += 4) {
      const d = Math.round(tpdf(i) * 1);
      data[i] = Math.max(0, Math.min(255, data[i] + d));
    }
  };
  CanvasRenderingContext2D.prototype.getImageData = native(function (...a) {
    const img = origGid.apply(this, a);
    try {
      ditherCanvas(img.data);
    } catch {
      /* */
    }
    return img;
  }, "getImageData");
  HTMLCanvasElement.prototype.toDataURL = native(function (...a) {
    try {
      const ctx = this.getContext("2d");
      if (ctx && this.width && this.height) {
        const img = origGid.call(ctx, 0, 0, this.width, this.height);
        ditherCanvas(img.data);
        ctx.putImageData(img, 0, 0);
      }
    } catch {
      /* */
    }
    return toDataURL.apply(this, a);
  }, "toDataURL");

  try {
    const proto = AudioBuffer.prototype;
    const dithered = new WeakSet();
    const origGet = proto.getChannelData;
    const paint = (arr, off) => {
      const amp = 1.5e-5;
      for (let i = 0; i < arr.length; i++) arr[i] += tpdf(i + (off || 0)) * amp;
    };
    proto.getChannelData = native(function (ch) {
      const data = origGet.call(this, ch);
      if (data && data.length > 8 && !dithered.has(this)) {
        dithered.add(this);
        paint(data, ch * 997);
      }
      return data;
    }, "getChannelData");
    if (proto.copyFromChannel) {
      const origCopy = proto.copyFromChannel;
      proto.copyFromChannel = native(function (dest, ch, start) {
        origGet.call(this, ch);
        if (this && !dithered.has(this)) {
          const data = origGet.call(this, ch);
          if (data && data.length > 8) {
            dithered.add(this);
            paint(data, (ch || 0) * 997);
          }
        }
        return origCopy.call(this, dest, ch, start);
      }, "copyFromChannel");
    }
  } catch {
    /* */
  }
  try {
    if (window.AnalyserNode) {
      const origF = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = native(function (arr) {
        origF.call(this, arr);
        if (arr && arr.length) {
          for (let i = 0; i < arr.length; i++) arr[i] += tpdf(i) * 0.04;
        }
      }, "getFloatFrequencyData");
    }
  } catch {
    /* */
  }

  try {
    const origMeasure = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = native(function (text) {
      const m = origMeasure.call(this, text);
      const d = tpdf(String(text || "").length) * 0.002;
      try {
        Object.defineProperty(m, "width", { value: m.width + d });
      } catch {
        /* */
      }
      return m;
    }, "measureText");
  } catch {
    /* */
  }

  try {
    const jitterRect = (r, tag) => {
      const n = tpdf((String(tag || "x").length * 17) ^ (r.width | 0)) * 0.015;
      return new DOMRect(r.x, r.y, r.width + n, r.height + n * 0.3);
    };
    const origGbr = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = native(function () {
      return jitterRect(origGbr.call(this), this.tagName);
    }, "getBoundingClientRect");
    const origGcr = Element.prototype.getClientRects;
    Element.prototype.getClientRects = native(function () {
      const list = origGcr.call(this);
      try {
        const out = [];
        for (let i = 0; i < list.length; i++) out.push(jitterRect(list[i], this.tagName));
        out.item = (i) => out[i] || null;
        return out;
      } catch {
        return list;
      }
    }, "getClientRects");
  } catch {
    /* */
  }

  try {
    const WIN = [
      "Arial",
      "Arial Black",
      "Calibri",
      "Cambria",
      "Candara",
      "Comic Sans MS",
      "Consolas",
      "Courier New",
      "Georgia",
      "Impact",
      "Lucida Console",
      "Lucida Sans Unicode",
      "Microsoft Sans Serif",
      "Palatino Linotype",
      "Segoe UI",
      "Tahoma",
      "Times New Roman",
      "Trebuchet MS",
      "Verdana",
      "Wingdings",
      "Symbol",
    ];
    if (document.fonts && document.fonts.check) {
      const orig = document.fonts.check.bind(document.fonts);
      document.fonts.check = native(function (font, text) {
        const fam = String(font || "").replace(/^[^"']*["']?/, "").replace(/["'].*$/, "").trim();
        if (WIN.some((f) => fam.toLowerCase() === f.toLowerCase())) return true;
        return orig(font, text);
      }, "check");
    }
  } catch {
    /* */
  }

  const deadRtc = native(function RTCPeerConnection() {
    throw new DOMException("Operation is not supported", "NotSupportedError");
  }, "RTCPeerConnection");
  window.RTCPeerConnection = deadRtc;
  window.webkitRTCPeerConnection = deadRtc;

  try {
    Object.defineProperty(navigator, "connection", { get: () => undefined });
  } catch {
    /* */
  }

  ["__playwright", "__pw_manual", "__PW_inspect", "__webdriver_evaluate", "__selenium_unwrapped", "_phantom"].forEach(
    (k) => {
      try {
        delete window[k];
      } catch {
        /* */
      }
    }
  );
}

export async function launchBrowser(opts = {}) {
  let chromium;
  let viaLib = "playwright";
  try {
    ({ chromium } = await import("patchright"));
    viaLib = "patchright";
  } catch {
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      throw new Error("Playwright/Patchright not installed · run INSTALL-JOKERZ.bat");
    }
  }

  const ident = getIdentity(opts.taskId || opts.sessionId || "anon");
  const geo = opts.proxy ? await geoForProxy(opts.proxy).catch(() => null) : null;
  const tz = geo?.tz || ident.tz || opts.timezoneId || "America/New_York";
  const lat = geo?.lat ?? ident.lat;
  const lon = geo?.lon ?? ident.lon;
  const headed = opts.headed === true;
  const proxy = parseProxy(opts.proxy);
  const w = ident.width || 1920;
  const h = ident.height || 1080;
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-default-browser-check",
    "--no-first-run",
    "--disable-infobars",
    "--disable-component-update",
    "--password-store=basic",
    "--use-mock-keychain",
    `--window-size=${w},${h}`,
    "--window-position=0,0",
    "--lang=en-US",
    "--accept-lang=en-US,en;q=0.9",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--enforce-webrtc-ip-permission-check",
    "--disable-webrtc-hw-encoding",
    "--disable-webrtc-hw-decoding",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-hang-monitor",
    "--disable-sync",
    "--disable-domain-reliability",
    "--metrics-recording-only",
    "--hide-crash-restore-bubble",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutomationControlled,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,DialMediaRouteProvider",
  ];
  if (!headed) {
    args.push("--headless=new", "--use-gl=angle", "--use-angle=swiftshader", "--hide-scrollbars");
  }

  const launchOpts = {
    headless: headed ? false : true,
    args,
    ignoreDefaultArgs: ["--enable-automation", "--enable-blink-features=IdleDetection"],
    proxy,
    chromiumSandbox: true,
  };

  let browser;
  let via = `${viaLib}+chromium`;
  try {
    browser = await chromium.launch({ ...launchOpts, channel: "chrome" });
    via = `${viaLib}+chrome`;
  } catch {
    browser = await chromium.launch(launchOpts);
  }

  const mobile = opts.mobile === true;
  const IPHONE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1";
  const context = await browser.newContext({
    userAgent: opts.userAgent || (mobile ? IPHONE_UA : CHROME_131.ua),
    locale: "en-US",
    timezoneId: tz,
    geolocation:
      lat != null && lon != null
        ? { latitude: Number(lat), longitude: Number(lon), accuracy: 35 + ((ident.seed || 1) % 40) }
        : undefined,
    permissions: lat != null ? ["geolocation"] : undefined,
    viewport: mobile ? { width: 390, height: 844 } : { width: ident.width, height: ident.height },
    screen: mobile ? { width: 390, height: 844 } : { width: ident.width, height: ident.height },
    deviceScaleFactor: mobile ? 3 : ident.dpr || 1,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: "light",
    extraHTTPHeaders: mobile
      ? { "Accept-Language": "en-US,en;q=0.9", ...(opts.headers || {}) }
      : { ...CHROME_131_HEADERS, ...(opts.headers || {}) },
  });
  await context.addInitScript(stealthInit, {
    major: CHROME_131.major,
    full: CHROME_131.full,
    cores: ident.cores,
    memory: ident.memory,
    gpuVendor: ident.gpuVendor,
    gpuRenderer: ident.gpuRenderer,
    canvasNoise: ident.canvasNoise,
    audioNoise: ident.audioNoise,
    seed: ident.seed,
    headed,
  });
  if (opts.cookies?.length) {
    await context.addCookies(opts.cookies).catch(() => {});
  }
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    headed,
    via,
    identity: ident,
    geo,
    identityHint: [identityHint(ident), geoHint(geo)].filter(Boolean).join(" · "),
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
