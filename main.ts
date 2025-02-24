#!/usr/bin/env -S deno run --allow-net=api.telegram.org:443,cloud.tionis.dev,ntfy.tionis.dev,0.0.0.0:8080 --allow-env --unstable-cron
import * as yaml from "jsr:@std/yaml";

const config_url = Deno.env.get("NTFY_CONFIG_URL");

interface trigger {
  PingDelaySeconds: number;
  NotificationRepeatDelaySeconds?: number; // Defaults to PingDelaySeconds
}

async function notify(
  source: string | undefined,
  channel: string | undefined,
  content: object | string,
  silent: boolean | undefined = false,
) {
  const token = Deno.env.get("GUPPI_TELEGRAM_TOKEN");
  if (token === undefined || token === "") {
    throw new Error("Telegram token not set");
  }
  const chatId = "248533143";
  let message = `${source || "unknown"}@${channel || "unknown"}:\n`;
  switch (typeof content) {
    case "string":
      message += content;
      break;
    case "object":
      message += "```json\n" + JSON.stringify(content, null, 2) + "\n```";
      break;
    default:
      message += String(content);
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      parse_mode: "markdown",
      text: message,
      disable_notification: silent,
    }),
  });
  if (resp.status !== 200) {
    console.error(await resp.text());
    throw new Error("Failed to send notification");
  }
}

interface marshalledNtfyToken {
  channelRegex: string;
  name: string;
}

interface ntfyToken {
  channelRegex: RegExp;
  name: string;
}

function UnmarshallNtfyToken(token: marshalledNtfyToken): ntfyToken {
  return {
    channelRegex: new RegExp(token.channelRegex),
    name: token.name,
  };
}

const ntfyTokenValidDuration = 1000 * 60 * 1; // 1 minute
interface cachedNtfyToken {
  token: ntfyToken | null;
  validUntil: Date;
}

const ntfyTokenCache = new Map<string, cachedNtfyToken>();

async function getNtfyToken(token: string): Promise<ntfyToken> {
  const cached = ntfyTokenCache.get(token);
  if (cached) {
    if (cached.validUntil.getTime() > Date.now()) {
      if (!cached.token) {
        throw new Error("Token not found");
      }
      return cached.token;
    }
  }
  let tokenContents:
    | string
    | webdav.BufferLike
    | webdav.ResponseDataDetailed<string | webdav.BufferLike>;
  try {
    tokenContents = await ntfyDavClient.getFileContents(
      "tokens/" + token + ".yaml",
    );
  } catch (e) {
    console.error(e);
    ntfyTokenCache.set(token, {
      token: null,
      validUntil: new Date(Date.now() + ntfyTokenValidDuration),
    });
    throw new Error("Token not found");
  }
  const unmarshalled = UnmarshallNtfyToken(
    yaml.parse(tokenContents.toString()) as marshalledNtfyToken,
  );
  ntfyTokenCache.set(token, {
    token: unmarshalled,
    validUntil: new Date(Date.now() + ntfyTokenValidDuration),
  });
  return unmarshalled;
}

async function handleNtfyRequest(request: Request) {
  // If request is for /healthz return 200 OK
  if (new URL(request.url).pathname === "/healthz") {
    return new Response("OK", { status: 200 });
  }

  let token = request.headers.get("Authorization");
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  if (!token) {
    if (queryToken) {
      token = queryToken;
    } else {
      token = "public";
    }
  }
  let ntfyToken;
  try {
    ntfyToken = await getNtfyToken(token);
  } catch (e) {
    console.error(e);
    return new Response("Unauthorized", { status: 403 });
  }
  const channel = url.pathname.slice(1);
  if (!ntfyToken.channelRegex.test(channel)) {
    return new Response("Unauthorized", { status: 403 });
  }

  const silent = url.searchParams.get("silent") === "true";
  const format = url.searchParams.get("format");
  const queryText = url.searchParams.get("message");
  const isGET = request.method === "GET";

  switch (format) {
    case "json": {
      const data = isGET ? queryText : await request.json();
      if (data == null) {
        return new Response("No data found", { status: 400 });
      }
      await notify(ntfyToken.name, channel, data, silent);
      return new Response("OK", { status: 200 });
    }
    case "apprise_json": {
      const data = isGET ? queryText : await request.json();
      if (data == null) {
        return new Response("No data found", { status: 400 });
      }
      const message = `# ${data.title || "no title"} (${
        data.type || "no type"
      })\n${data.message}`;
      await notify(ntfyToken.name, channel, message, silent);
      return new Response("OK", { status: 200 });
    }
    case "md":
    case "markdown":
    default: {
      const data = queryText ? queryText : await request.text();
      if (data == null) {
        return new Response("No data found", { status: 400 });
      }
      await notify(ntfyToken.name, channel, data, silent);
      return new Response("OK", { status: 200 });
    }
  }
}

Deno.serve({ port: 8080 }, handleNtfyRequest);
